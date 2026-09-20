export class ApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiBase() {
  const configured = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_API_BASE : null;
  return String(configured || '/api').replace(/\/+$/, '');
}

function requestUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return baseUrl + '/' + String(path).replace(/^\/+/, '');
}

// 服务端（或反向代理）返回非 JSON 时，至少把状态码翻译成能看懂的话。
function fallbackMessage(status, generic) {
  if (status === 413) return '文件或请求内容超过服务器限制，请压缩后重试（或联系管理员调整上传上限）';
  if (status === 502 || status === 504) return '服务暂时不可用，请稍后重试';
  if (status === 401) return '登录已失效，请重新登录';
  if (status === 403) return '没有权限执行该操作';
  if (status >= 500) return '服务器内部错误，请稍后重试';
  return `${generic}（HTTP ${status}）`;
}

export function createApiClient({ baseUrl = apiBase(), getToken = () => null, onUnauthorized = () => {} } = {}) {
  async function request(path, { method = 'GET', body, headers = {}, signal, timeoutMs = 0 } = {}) {
    const token = getToken();
    // 超时（2026-09-17）：不设的话，请求一旦挂住就**永远转圈** —— 学生会以为卡死、
    // 刷新页面再点，而服务端那边每次点击都是一次真实的重活（开环境的并发互撞就是这么来的）。
    // 超时后明确报错，比永远转圈强得多。timeoutMs = 0 表示不设（保持原有行为）。
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetch(requestUrl(baseUrl, path), {
        method,
        signal: signal || controller?.signal,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new ApiError(`等了 ${Math.round(timeoutMs / 1000)} 秒还没有响应，这次就不再等了（服务端可能仍在处理，稍等一下再试，别连续点）`, {
          status: 0, code: 'REQUEST_TIMEOUT', details: null,
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok || payload?.success === false) {
      const error = payload?.error || {};
      const apiError = new ApiError(error.message || fallbackMessage(response.status, '请求未能完成，请稍后重试'), {
        status: response.status,
        code: error.code || 'REQUEST_FAILED',
        details: error.details || null,
      });
      if (response.status === 401 || apiError.code === 'UNAUTHORIZED') onUnauthorized(apiError);
      throw apiError;
    }
    return payload?.data ?? payload;
  }

  return {
    request,
    get: (path, options = {}) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options = {}) => request(path, { ...options, method: 'POST', body }),
    // SSE：返回原始 Response 交给调用方逐块读取（EventSource 不能带 Authorization 头）
    stream: async (path, { method = 'POST', body, headers = {}, signal } = {}) => {
      const token = getToken();
      const response = await fetch(requestUrl(baseUrl, path), {
        method,
        signal,
        credentials: 'include',
        headers: {
          accept: 'text/event-stream',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
        const error = payload?.error || {};
        const apiError = new ApiError(error.message || fallbackMessage(response.status, '请求未能完成，请稍后重试'), {
          status: response.status, code: error.code || 'REQUEST_FAILED', details: error.details || null,
        });
        if (response.status === 401 || apiError.code === 'UNAUTHORIZED') onUnauthorized(apiError);
        throw apiError;
      }
      return response;
    },
    upload: async (path, file, fields = {}, { onProgress } = {}) => {
      const form = new FormData();
      Object.entries(fields).forEach(([key, value]) => { if (value !== undefined && value !== null) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value)); });
      form.append('file', file, file.name);
      const token = getToken();
      const response = await fetch(requestUrl(baseUrl, path), { method: 'POST', credentials: 'include', headers: { accept: 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: form });
      if (onProgress) onProgress(100);
      const text = await response.text(); let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (!response.ok || payload?.success === false) { const error = payload?.error || {}; throw new ApiError(error.message || fallbackMessage(response.status, '上传未能完成，请稍后重试'), { status: response.status, code: error.code || 'UPLOAD_FAILED', details: error.details || null }); }
      return payload?.data ?? payload;
    },
    // 把「需要鉴权才能读」的素材取回来、转成 blob: 地址。
    // `<img>` / `<video>` / `<audio>` 的请求带不了 Authorization 头，把 /api/** 直接塞进 src 必然 401、
    // 图永远出不来（学生拖进来的本地素材、老师给框体配的预置素材都是这种地址）。
    fetchBlobUrl: async (path) => {
      // 传进来的往往是根路径（快照里存的就是 /api/...）：这种直接用，别再拼一次 baseUrl（会变成 /api/api/...）
      const target = String(path || '');
      const token = getToken();
      const response = await fetch(target.startsWith('/') ? target : requestUrl(baseUrl, target), { credentials: 'include', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}) } });
      if (!response.ok) throw new ApiError(fallbackMessage(response.status, '素材读取失败'), { status: response.status, code: 'ASSET_FETCH_FAILED', details: null });
      return URL.createObjectURL(await response.blob());
    },
    // 把同样的素材取回来、转成 **data:** 地址。两种场合非它不可：
    //   ① 要嵌进 opaque origin 的沙箱 iframe（网页作品预览）：那个文档**拿不到**父页面的 blob: 地址；
    //   ② 拿到 blob: 之后想再 `fetch()` 它 —— 生产 CSP 是 `connect-src 'self'`，blob: 只在 img-src 白名单里，
    //      再 fetch 会被直接拦成 "Failed to fetch"（2026-09-20 「我的作品」踩到过，org 端 CSP 不同所以没暴露）。
    // 所以这一步**直接从 /api/ 取字节**，别绕 blob: 中转。
    fetchDataUrl: async (path) => {
      const target = String(path || '');
      const token = getToken();
      const response = await fetch(target.startsWith('/') ? target : requestUrl(baseUrl, target), { credentials: 'include', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}) } });
      if (!response.ok) throw new ApiError(fallbackMessage(response.status, '素材读取失败'), { status: response.status, code: 'ASSET_FETCH_FAILED', details: null });
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new ApiError('素材读取失败', { status: 0, code: 'ASSET_READ_FAILED', details: null }));
        reader.readAsDataURL(blob);
      });
    },
    put: (path, body, options = {}) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options = {}) => request(path, { ...options, method: 'PATCH', body }),
    delete: (path, options = {}) => request(path, { ...options, method: 'DELETE' }),
    login: (credentials) => request('auth/login', { method: 'POST', body: credentials }),
    logout: () => request('auth/logout', { method: 'POST' }),
    me: () => request('me'),
  };
}
