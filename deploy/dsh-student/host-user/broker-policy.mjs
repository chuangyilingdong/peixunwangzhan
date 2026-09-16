// 特权代理的**校验与参数拼装**（纯函数，没有 I/O）—— 单独放一个文件是为了能被守卫测到。
//
// 为什么值得单独抽出来：这段校验里出过一个只在真机上才暴露的 bug ——
// 名字模式写成了 `[^\\/\0]`（**不允许斜杠**），可平台传的正是「工作区相对路径」
// （`deck/演示文稿.pptx`），于是 PPT 一提交就报「name 不合法」，错误文案却写着
// 「必须是工作区内的相对路径」。校验逻辑不该只能靠真机试出来。
//
// 尺度：这里只做「明显不该收的就别往后传」；**真正的越界判定在工作区那一层**
// （collect-student.mjs 的 resolveInside：realpath 必须落在工作区内、拒符号链接），
// 两边分工写清楚，免得以后有人以为这里就是全部防线。

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function fail(message, code = 'BROKER_BAD_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 命令行值：不能为空、不能以 `-` 开头（会被目标脚本当成选项）、不能带 NUL/换行。 */
export function safeValue(value, label, max = 500) {
  const text = String(value ?? '');
  if (!text) throw fail(`${label} 不能为空`);
  if (text.length > max) throw fail(`${label} 太长`);
  if (text.startsWith('-')) throw fail(`${label} 不能以 - 开头`);
  if (/[\0\n\r]/.test(text)) throw fail(`${label} 含非法字符`);
  return text;
}

/** 工作区相对路径：**允许**斜杠（就是要传相对路径），但不许越界、不许绝对路径。 */
export function safeRelativeName(value) {
  const raw = String(value ?? '');
  if (!raw || raw.length > 200) throw fail('产物名长度不合法');
  if (/[\0\\]/.test(raw)) throw fail('产物名含非法字符');
  if (raw.startsWith('/') || raw.startsWith('-')) throw fail('产物名不能以 / 或 - 开头');
  const segments = raw.split('/').filter((segment) => segment && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) throw fail('产物名不能越出工作区');
  return segments.join('/');
}

/**
 * 把一次请求翻译成「跑哪个脚本、带什么参数」。
 * @param {object} request 一行 JSON 请求
 * @param {{launch:string, stop:string, collect:string}} scripts 固定脚本路径（不从请求来）
 */
export function buildRequestPlan(request, scripts, timeouts) {
  const session = String(request?.session ?? '');
  const student = String(request?.student ?? '');
  if (!ID_PATTERN.test(session)) throw fail('session 不合法');
  if (!ID_PATTERN.test(student)) throw fail('student 不合法');
  const base = ['--session', session, '--student', student];

  if (request?.op === 'launch') {
    return {
      script: scripts.launch,
      timeout: timeouts.launch,
      context: { op: 'launch', student },
      args: [...base,
        '--key', safeValue(request.key, 'key', 4000),
        '--gateway', safeValue(request.gateway, 'gateway', 400),
        '--ticket', safeValue(request.ticket, 'ticket', 400),
        ...(request.visionModel ? ['--vision-model', safeValue(request.visionModel, 'visionModel', 120)] : []),
        ...(request.containerName ? ['--name', safeValue(request.containerName, 'containerName', 80)] : []),
      ],
    };
  }
  if (request?.op === 'stop') {
    return { script: scripts.stop, timeout: timeouts.stop, context: { op: 'stop', student }, args: base };
  }
  if (request?.op === 'collect') {
    const mode = String(request.mode ?? '');
    if (mode === 'list') return { script: scripts.collect, timeout: timeouts.collect, context: { op: 'collect', student, mode }, args: [...base, '--list'] };
    if (mode === 'preserve') return { script: scripts.collect, timeout: timeouts.collect, context: { op: 'collect', student, mode }, args: [...base, '--preserve'] };
    if (mode === 'export') {
      const name = safeRelativeName(request.name);
      return { script: scripts.collect, timeout: timeouts.collect, context: { op: 'collect', student, mode, name }, args: [...base, '--export', name] };
    }
    throw fail(`collect 不认识的 mode：${mode}`);
  }
  throw fail(`不认识的 op：${request?.op}`);
}
