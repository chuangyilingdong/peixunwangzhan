/**
 * 画布「可提交产出」的唯一判定口径 —— **前端与服务端共用这一份**（2026-09-24 用户口径）。
 *
 * 为什么要有它：提交作品原来是「一提交就永久只读」，学生做完一个任务就没法继续做剩下的；
 * 而且「提交作品」只看画布上有没有节点，空画布、光秃秃的占位框体也能提交。
 * 现在改成**增量提交**：只有出现**新的产出**才允许再提交一次，提交完画布照样能编辑。
 *
 * 「可提交产出」= 用户逐条确认过的口径：
 *   ✅ 新成功生成的文字（`generatedText`）、新成功生成的图片/视频/音乐（`assetUrl` / `previewUrl`）、
 *      新上传完成的本地产物（`uploaded === true` / `fileAssetId`）；
 *   ❌ 不算：改提示词、移动框体、连线变化、普通占位框体、正在生成中、上传未完成。
 * 所以这里的判据**只看产出字段**，不看 position / 提示词 / 连线 / 选中态。
 *
 * ⚠️ 服务端导入的是这个文件本身（不是 `@platform/shared` 的入口）——
 *    入口会把 React 组件一起拉进来，服务端加载不了（同 `deckSpec.js` 那套做法）。
 */

/** 双段 32 位滚动散列：单段在几十条产出上还够用，两段拼起来是为了不去赌碰撞。 */
function shortHash(text) {
  let h1 = 5381;
  let h2 = 52711;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = ((h1 * 33) ^ code) >>> 0;
    h2 = ((h2 * 31) + code) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

function nodeData(node) {
  return node?.data || node?.props || {};
}

/**
 * 一个节点带没带「产出」。带就返回它的身份键，不带就返回 ''。
 *
 * 键里**故意不含节点 id**：删除再挂回来（或把生成好的框体重新拖回画布）不该被当成"新的产出"——
 * `addBoxToCanvas` 会把同一个任务的素材重新挂上，那时 id 变了、产出没变。
 * 反过来，真的重新生成一次会拿到新的地址（或新的文字），键自然就变了。
 */
export function canvasNodeOutputKey(node) {
  const data = nodeData(node);
  // 上传中的本地文件还不算产出（用户口径：上传未完成不算）
  if (data.uploading === true) return '';
  const text = String(data.generatedText || '').trim();
  if (text) return `text:${shortHash(text)}:${text.length}`;
  const url = String(data.assetUrl || data.previewUrl || '').trim();
  if (url) return `file:${shortHash(url)}:${url.length}`;
  // 极端兜底：只有 fileAssetId / uploaded 而没有地址（历史数据）也算产出，口径里明确点了这两个字段。
  const fileAssetId = String(data.fileAssetId || '').trim();
  if (fileAssetId && data.uploaded === true) return `asset:${fileAssetId}`;
  return '';
}

/** 画布上所有产出的身份键（去重后按字典序排好，保证同一份画布永远得到同一个指纹）。 */
export function canvasOutputKeys(snapshot) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const keys = new Set();
  for (const node of nodes) {
    const key = canvasNodeOutputKey(node);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/** 产出指纹：存进 `student_projects.last_submitted_output_signature` 的那份东西。没有产出时是 ''。 */
export function canvasOutputSignature(snapshot) {
  const keys = canvasOutputKeys(snapshot);
  return keys.length ? JSON.stringify(keys) : '';
}

function parseSignature(signature) {
  const raw = String(signature || '').trim();
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map((item) => String(item)));
  } catch { /* 老行/脏数据当成"没提交过产出"处理，宁可多给一次提交机会，也别把学生卡死 */ }
  return new Set();
}

/** 相对「上一次提交」而言**新增**的产出（提交按钮的激活判据就是它非空）。 */
export function newCanvasOutputKeys(snapshot, submittedSignature) {
  const submitted = parseSignature(submittedSignature);
  return canvasOutputKeys(snapshot).filter((key) => !submitted.has(key));
}

/** 画布上有没有"还没提交过"的产出。 */
export function hasUnsubmittedOutput(snapshot, submittedSignature) {
  return newCanvasOutputKeys(snapshot, submittedSignature).length > 0;
}

/**
 * 画布还开着吗（学生能不能继续编辑 / 继续生成）？
 *
 * 提交之后**画布不锁**（用户口径：提交完还要能继续做没做完的任务），所以 SUBMITTED 也能编辑；
 * 真正决定"还能不能用"的是**课堂还在不在上**——那一条由服务端的课堂上下文（canUseNow）说了算，
 * 客户端这里只管状态位。GRADED / ARCHIVED 一律不能编辑。
 */
export function isCanvasEditableProjectStatus(status) {
  return ['DRAFT', 'SUBMITTED'].includes(String(status || '').toUpperCase());
}

/**
 * 「提交期间冻结保存、并让在途的旧自动保存响应失效」的那个闸门（2026-09-24 §十二 的竞态要求）。
 *
 * 为什么要单独一个东西：自动保存是 1.2 秒防抖 + 异步的，提交又是另一条请求。两者交错时，
 * **先发出去的保存可能后回来**，把已提交的指纹/快照覆盖回旧值（界面还会显示"已保存"）。
 * 纯函数不好测、也不好读，所以口径固定成三条：
 *   · `beginSubmit()` 之后 `frozen` 为真 → 新的自动保存不许开始；
 *   · `beginSubmit()` 会让**所有在途请求**拿到 `false`（`isCurrent`）→ 它们的响应一律丢掉；
 *   · `endSubmit()` 之后一切照旧（下一轮保存用新的 token）。
 */
export function createSaveGate() {
  let frozen = false;
  let token = 0;
  return {
    beginSubmit() { frozen = true; token += 1; return token; },
    endSubmit() { frozen = false; },
    get frozen() { return frozen; },
    /** 供在途请求判断"我这次的结果还算不算数"。 */
    isCurrent(requestToken) { return requestToken === token; },
    currentToken() { return token; },
  };
}
