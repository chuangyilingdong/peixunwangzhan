# RDS 阶段 1 改造工具（数据访问同步 → 异步）

2026-09-23 用这个工具把 **1203 处数据访问**从同步 API（`row/rows/q/one/count/transaction`）
改成异步 API（`arow/arows/aq/aone/acount/atransaction`），并把 `async` **顺着调用链传播**到
530 个函数、补了 1250+ 处 `await`、改了 74 处数组回调、补了 80 个文件的 import。

**为什么必须是 AST 工具而不是正则**：把一个函数改成 `async` 之后，**它的调用者也必须 `await`** ——
而调用者不是数据访问调用，静态 grep 抓不到。而且有几类位置加 `await` 是语法错或语义错
（参数默认值、getter、`arr.map(cb)` 的返回值、`f().finally(cb)` 的 Promise 链），必须按父节点判定。

## 怎么跑

```bash
# 解析器不在仓库里（故意不动 lockfile）
npm i acorn@8 --prefix .tmp/codemod-deps

node scripts/rds-p1-codemod/report.mjs                  # 只看统计（不减）
node scripts/rds-p1-codemod/transform.mjs               # 试运行（不写盘）
node scripts/rds-p1-codemod/transform.mjs --write       # 写盘（应用 + 数据库层）
node scripts/rds-p1-codemod/transform.mjs --write --with-scripts   # 连验收脚本一起改
node scripts/rds-p1-codemod/verify.mjs                  # 静态不变量验收（漏 await / async 回调 / 语法）
```

跑完请接着跑独立的验收：
`node scripts/p137-async-db-await.mjs`（门禁）＋ `node .tmp/rds-codemod/run-suite.mjs`（154 个验收脚本）。

## 它做哪几件事

| 规则 | 做什么 |
| --- | --- |
| ① | 含数据访问的函数加 `async`（含跨文件传播，直到"已经被 await 的调用点"为止） |
| ② | `row(…)` → `await arow(…)`；被当成对象用时补括号（`q(…).changes` → `(await aq(…)).changes`） |
| ③ | `transaction(fn)` → `await atransaction(fn)` |
| ④ | 调用"这次才变 async"的函数的地方补 `await`（**基线里本来就是 async 的不动**，见下） |
| ⑤ | `assert.throws(async cb)` → `await assert.rejects(cb)`（`throws` 抓不到 reject） |
| ⑥ | `arr.forEach(cb)` → `for (const … of …)`；`arr.map(cb)` → `await amap(arr, cb)`（**顺序版**，不是 `Promise.all`） |
| ⑦ | 给用到异步名的文件补 import（含 `lib.js` 的 re-export、动态 import、`load(...)` 包装） |

## 它在实测里栽过的坑（都留了教训在代码注释里）

1. **前向引用**：调用点写在函数声明之前（JS 会提升）——就地查作用域会查不到 → 漏 await。**解析必须等遍历结束**。
2. **命名空间/解构式动态 import**（`const seed = await import(…)` / `const { q } = await import(…)`）
   和**算出来的路径**（`pathToFileURL(path.join(root, 'apps/…')).href`、`load('apps/…')` 包装）。
3. **`entries()` 给的是 `[index, value]`**：`forEach((item, i) => …)` 改 for…of 时两个变量会**对调**（语法不报错、静默算错）。
4. **`.map` 用 `Promise.all` 会改顺序语义**：同步 map 是一个接一个跑的，包成并发后"靠 Set 累积判批次内重复"这类逻辑就静默失效 → 改用顺序版 `amap`。
5. **`f().finally(cb)` 不能写成 `(await f()).finally(cb)`**：await 拿到的是**解析值**，不是 Promise。
6. **数组回调的判据是"回调自己是不是 async"**，不是"它访不访问数据库"——第 1 趟改名后后者就没了信号（实测漏 41 处）。
7. **基线里本来就是 async 的函数，调用形态是有意的**（fire-and-forget / Promise 链 / 靠外层收口），
   `await` 不许动（实测打挂 p105 的"预热不能等"、p11 的 `.finally`）。

## 它**不做**什么

- 不动 `packages/database/src/schema.js`（那里是同步原语与异步外壳的**实现**，改了就是自己吃自己）。
- 不动 `deploy/` 下算路径的动态 import（那些是跑在服务器 release 上的）。
- `.filter/.some/.every/.sort` 的 async 回调**不自动改**（会报出来要人处理）——当前为 0 处。
