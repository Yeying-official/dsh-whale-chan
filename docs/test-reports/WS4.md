# WS4 测试报告

- 环境：Windows，Node `v24.15.0`，pnpm `11.4.0`，vitest `4.1.8`
- 分支：`feat/ws4-executor`（从 `main` `6fcacb0` 创建）
- 范围：`src/executor/**`、`cordis.patch.yml`、`package.json`（devDependency `yaml`）、
  `tests/executor-*.spec.ts`、`tests/presets.spec.ts`、`tests/fixtures/executor.ts`、
  `docs/003-execution.md`、`docs/006-deployment.md`、`docs/007-architecture.md`
  第二轮（审核整改）未改 `src/index.ts`，执行器不再从宿主入口导出

## 1. 门禁命令与真实输出

```text
$ pnpm install --frozen-lockfile
Already up to date
Done in 415ms using pnpm v11.4.0

$ pnpm typecheck
$ tsc --noEmit
（无输出，退出码 0）

$ pnpm test
 ✓ tests/executor-session.spec.ts (13 tests) 91ms
 ✓ tests/executor-research.spec.ts (10 tests) 53ms
 ✓ tests/executor-task.spec.ts (31 tests) 52ms
 ✓ tests/executor-model.spec.ts (21 tests) 44ms
 ✓ tests/presets.spec.ts (17 tests) 21ms
 ✓ tests/executor-role-model.spec.ts (12 tests) 14ms
（另有既有 27 个 spec 文件）

 Test Files  33 passed (33)
      Tests  439 passed (439)

$ pnpm build
ℹ [CJS] lib\client.js    42.04 kB │ gzip: 12.48 kB
ℹ [ESM] lib\index.js    19.94 kB │ gzip:  6.32 kB
ℹ [ESM] lib\index.d.ts   0.75 kB │ gzip:  0.33 kB
✔ Build complete

$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!

$ node scripts/check-pack.mjs
pack check passed: 15 artifacts, icon 711 bytes

$ git status --porcelain
（提交后为空）
```

`pnpm install --frozen-lockfile` 在新增 `yaml` devDependency 之后仍然通过，说明 lock 已正确
更新且没有引入其它变化。

## 2. 新增测试

| 文件                                | 条数 | 覆盖                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/executor-task.spec.ts`       | 31   | 批准门（pending / 未批准任务 / 错配批准 / 不安全 id）、会话参数与模型路由、批准目录优先 / `~` 展开 / 空值回退 / 相对路径拒绝、系统提示内容、投递一次、四种结局、取消幂等、回调恰好一次、失败监听器不影响结果、同任务并发拒绝、重试新会话与「上一轮结果」 |
| `tests/executor-model.spec.ts`      | 21   | 提示组装与分隔、超预算丢最旧、单条超长截断、system 永不丢、会话 id/标题/工作区/preset、回复路由透传与缺省、会话复用、`forThread` 隔离、串行互斥、轮数重建（`fresh` + 旧会话取消）、空闲重建、超时/失败/中止三类错误、空文本、dispose                     |
| `tests/executor-role-model.spec.ts` | 12   | 路由映射（含 effort、半配置、设置默认值）、`needsSeeding` 四种判断、空配置不注入、已有选择不覆盖、成功才 append + wire + flush、解析失败回退宿主默认                                                                                                     |
| `tests/executor-research.spec.ts`   | 10   | 事实/来源映射、hostname 兜底、非 http(s) 丢弃与去重、limit 上限、长事实截断、空结果、异常、中止、预算耗尽、空查询不调用                                                                                                                                  |
| `tests/executor-session.spec.ts`    | 13   | `TurnTracker` 归属回合、早于投递的 `turn/end`、历史已结束、aborted/failed 详情、无 requestId 的下一回合；`awaitTurn` 实时匹配、立即返回、订阅/扫描竞态补放、超时、中止、已中止不订阅、忽略无关事件                                                       |
| `tests/presets.spec.ts`             | 17   | 宿主行仍在、无重复 loader id、两套 preset 的 id/name/order、回复器工具集与「无 shell/fs/jobs/skill」、执行器工具集、shell 平台门控、jobs 5 秒、compaction 隔离、插件名语法、`!!js` 位置、两套 preset 的中性人设前缀                                      |

合计 **104** 条；仓库总数 335 → **439**。

## 3. 变异实验

每次只改一处，跑对应 spec，再完整还原（`git status` 确认无残留）：

| 编号 | 变异                                                | 结果                        |
| ---- | --------------------------------------------------- | --------------------------- |
| M1   | 去掉 `assertApproved` 的三项检查                    | `executor-task` 3 条失败    |
| M2   | `TurnTracker` 把任意 `turn/end` 当成投递回合的结束  | `executor-session` 3 条失败 |
| M3   | 去掉 `SessionModel` 的按 thread 互斥（`serialize`） | `executor-model` 1 条失败   |
| M4   | `assemblePrompt` 忽略预算                           | `executor-model` 3 条失败   |
| M5   | `onFinished` 被调用两次                             | `executor-task` 3 条失败    |

M2 第一次的替换因 Prettier 换行而未命中（测试全绿），改用正则并断言替换成功后复现失败；
这说明变异实验必须确认变异真的落盘。

## 4. DSH API 实测证据

来源一：`node_modules/@deepseek-ai/**/lib/types/**`（`tsc --noEmit` 通过即为签名正确）。
来源二：`cordis_inspect_query`（host，provider `Service`，`{"service":"<key>"}`）：

```text
sessionController | Host service backing the generated `ctx.remote.session` namespace.
   resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult>
   @Remote('create') create(request: SessionCreateRequest): Promise<SessionCreateValue>
   @Remote('rename') rename(request: SessionRenameRequest): Promise<SessionRenameValue>
   @Remote('prompt') async prompt(request, signal): Promise<SessionPromptValue>
   @Remote('cancel') cancel(request: SessionCancelRequest): SessionCancelValue
permissionPresets | Owns the deployment's configured permission presets …
   set(session: Session, name: string): void
workspaceRegistry | Durable workspace registry.
   async create(path: string, title?: string): Promise<Workspace>
agents | Agent service (`ctx.agents`) …
   get(id: SessionId): Agent | undefined
web | The web access service.
   async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
systemPrompt | Registry service for the prompt inputs assembled before each model step.
   section(section: PromptSection): () => void
sessionPersistence | Durable append-only session storage …
   abstract flush(): Promise<void>
llm | …
   resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
```

对应的声明文件片段（`dsh-agent/lib/types/runtime-types.d.ts`）：

```ts
cancel(cause: AgentCancelCause, options?: CancelOptions): void
followup(message: UserMessage): void
steer(message: UserMessage): void
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
whenIdle(): Promise<void>
readonly inbox: Inbox          // nextTurn / nextStep / clear / append / prepend / remove
readonly status: AgentStatus   // 'idle' | 'running'
```

`dsh-api-session-controller/lib/types/types.d.ts`：`declare module '@deepseek-ai/dsh-session/types'`
把 `'model/selection': ModelSelection` 加进 `SessionEventMap`（所以 `session.append('model/selection', …)`
是有类型的）。`dsh-system-prompt` 的 `system-prompt/assemble` 与 `dsh-agent` 的 `agent/request` 都是
waterfall，`ctx.on(..., { prepend: true })` 是 Cordis 的 `EventOptions.prepend`。

`dsh-session/lib/types/types.d.ts`：`'turn/end': { turn: number; reason: TurnEndReason }`，
`TurnEndReasonMap` 含 `completed` / `aborted({reason})` / `blocked` / `failed({error})`；
`dsh-session/lib/types/known-event-types.js` 是这批事件名的生成清单。

### 与任务书的差异

| 任务书假设                               | 实际                                | 处理                                                                 |
| ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| 取消用 `agent.interrupt/abort/stop` 之一 | 都不存在                            | 用 `agent.cancel({kind:'hook',reason}, {keepInbox:false})`           |
| `sessionController` 提供取消/清队列      | `cancel` 只中止当前回合、不清 inbox | 同一处改用 agent 级 cancel 并清队列                                  |
| 用 `sessionPersistence` 做幂等去重       | 会话日志已含恢复历史                | 直接读 `agent.session.snapshotEvents()`，无需 `flush()`              |
| 「关闭旧会话」可调用 API                 | 没有公开的关闭/销毁入口             | 取消其回合 + 不再引用；重建时 `create` 会返回新的 sessionId 并采纳   |
| preset 插件包是项目依赖                  | 随 DSH 发布                         | patch 只写包名；包是否存在于 `app.asar` 的 `dsh/node_modules` 已核对 |

## 5. 未覆盖与风险

- `DshSessionHost` 没有单元测试：它需要真实 DSH 宿主（会建会话、呼唤模型）。覆盖方式是
  ①类型检查；②`TurnTracker`/`awaitTurn` 纯逻辑的 13 条测试；③本报告记录每条签名。
  `ensureSession` 的错误分支（`resolveAgent` 返回 error、`rename` 抛错）只有类型级保护。
- 没有真实钉钉消息与真实模型调用；端到端留给 WS8。
- 没有测试 DSH 的账号/模型未配置时的行为（这会在 `create` 或首个回合上失败，表现为
  `failed` 结局或抛错）。
- 模型播种没有对着真实 provider 跑过：`role-model` 的测试替换了 `resolveCallConfig`，
  只验证「注入什么、什么时候跳过、失败如何回退」。真实路由由 DSH 的 `ctx.llm` 决定。
- 真机会话冒烟（创建会话、取消、观察 `turn/end`）写在
  [006 部署 §5.4](../006-deployment.md)，由 WS8 执行，本工作流未跑。

## 5.1 T3 真机反馈（回合上限）

首次真机分类调用（本机模型）在 15 秒内没有返回，brain 预算另派提高后，会话侧同步放宽：

- `MODEL_TURN_TIMEOUT_MS = 90_000`（新增于 `types.ts`，两角色共用）；`REPLY_TIMEOUT_MS` 改为它的别名，
  回复器单回合从 60 秒放宽到 90 秒。
- 执行器的 `awaitTurnEnd` 预算改为 `max(tasks.timeoutMinutes × 60s, 90s)`：任务总预算仍是
  `tasks.timeoutMinutes`，只是不会再低于一个回合的上限（1 分钟任务不会被 60 秒掐断）。
- 新增 4 条测试：回复器默认 90 秒、显式预算仍生效、任务长预算按时长、1 分钟任务仍有 90 秒下限。

一条教训：60 秒的回合上限对本机模型不够。测试无法发现这个问题——它需要真实的首 token 延迟，
所以这条上限的表达方式是「常量 + 断言」，方便下次直接调数值而不是散落在调用点。

## 6. 复核清单

| #   | 项目                    | 结论                                                      |
| --- | ----------------------- | --------------------------------------------------------- |
| ①   | 无批准不建会话          | 测试 3 条 + 变异 M1                                       |
| ②   | 投递幂等                | id 派生 + 日志/inbox 查重；fake host 与真实 host 同一语义 |
| ③   | 回调恰好一次            | `finally` + `started`；变异 M5                            |
| ④   | 会话复用不串话          | `SessionRef` 寻址 + thread 互斥；变异 M3                  |
| ⑤   | preset 字段真实、包存在 | 15 条 preset 测试 + `app.asar` 核对                       |
| ⑥   | 失败可被 brain 映射     | 三个错误类带 `reason`；检索失败返回空结果                 |
| ⑦   | 不碰真实外部            | 全部 fake；无网络、无子进程                               |
| ⑧   | API 实测                | §4                                                        |
| ⑨   | 文档整合                | `docs/007-architecture.md` 统一分层与端口                 |
| ⑩   | 提交规范、工作区干净    | §1 `git status` 为空；提交拆分见 PR 文档                  |
