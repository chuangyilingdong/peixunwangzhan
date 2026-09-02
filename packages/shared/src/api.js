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

export function createApiClient({ baseUrl = apiBase(), getToken = () => null, onUnauthorized = () => {} } = {}) {
  async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const token = getToken();
    const response = await fetch(requestUrl(baseUrl, path), {
      method,
      signal,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok || payload?.success === false) {
      const error = payload?.error || {};
      const apiError = new ApiError(error.message || '请求未能完成，请稍后重试', {
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
    put: (path, body, options = {}) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options = {}) => request(path, { ...options, method: 'PATCH', body }),
    delete: (path, options = {}) => request(path, { ...options, method: 'DELETE' }),
    login: (credentials) => request('auth/login', { method: 'POST', body: credentials }),
    logout: () => request('auth/logout', { method: 'POST' }),
    me: () => request('me'),
  };
}
