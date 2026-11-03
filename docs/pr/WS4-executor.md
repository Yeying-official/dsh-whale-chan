# WS4 · 任务执行器、回复器会话与 agent preset

- 分支：`feat/ws4-executor`（从 `main` `6fcacb0` 创建）
- 范围：`src/executor/**`（新增；`src/index.ts` 不改）、`src/core/errors.ts`（新增 `invalidWorkspace` 一个码）、`cordis.patch.yml`（追加两套 preset）、
  `package.json`（新增 devDependency `yaml`）、`tests/executor-*.spec.ts`、`tests/presets.spec.ts`、
  `tests/fixtures/executor.ts`、`docs/003-execution.md`、`docs/006-deployment.md`、`docs/007-architecture.md`
- 不做：HTTP 路由、设置持久化、面板、组合根接线（WS5）；不发真实钉钉消息、不调真实模型；
  未改 `src/shared|core|app|channel|brain|client`、`docs/PROGRESS.md`、`package.json` 的 runtime 依赖；
  未合并、未 push、未安装 profile

## 1. 目标

把「已批准的任务」变成一次真实的 DSH 会话执行，并为回复链路提供可注入的模型与检索实现：

1. **fail-closed**：没有批准就绝不建会话、绝不建工作区；
2. **投递幂等**：同一 requestId 只进会话一次，重启也不会重复；
3. **结局恰好一次**：成功 / 失败 / 超时 / 取消各对应一个 `ExecutorResult`，回调不重不漏；
4. **会话不串话**：按 `SessionRef` 寻址，无跨任务状态；回复器按 thread 串行；
5. **失败可映射**：模型与检索的失败带稳定 code，brain 能映射成 `timeout` / 降级；
6. **preset 用真实字段**：两套 preset 的字段与插件包名与 DSH 自带 preset 同构。

## 2. 模块

| 文件                           | 职责                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/executor/types.ts`        | `ExecutorRequest/Result`、`SessionHost`、`TaskExecutor`、preset 常量与 id 派生                   |
| `src/executor/errors.ts`       | `ExecutorError` 与 `ModelTimeoutError`/`ModelAbortedError`/`ModelFailedError`（带 `reason`）     |
| `src/executor/session-host.ts` | `DshSessionHost`（DSH 适配）、`TurnTracker`（回合匹配）、`awaitTurn`（超时/中止等待）            |
| `src/executor/task.ts`         | `DshTaskExecutor`：批准门、工作区、系统提示、投递、结局映射、取消、并发                          |
| `src/executor/model.ts`        | `SessionModel implements ModelPort`：按 thread 复用会话、串行、轮数/空闲重建、提示组装           |
| `src/executor/research.ts`     | `DshResearch implements ResearchPort`：`ctx.web.search` 适配与降级                               |
| `src/executor/role-model.ts`   | 把 `settings.models.reply/worker` 播种到新会话（`model/selection` + 首次请求注入，不改全局默认） |
| `src/executor/index.ts`        | 公开出口（**只**从这一层拿执行器；宿主入口 `src/index.ts` 不导出它）                             |
| `cordis.patch.yml`             | `dsh-whale-chan-replier-preset`、`dsh-whale-chan-worker-preset`                                  |

## 3. 实测到的 DSH API（不是猜的）

每条都来自 `node_modules/@deepseek-ai/**/lib/types/**` 的声明，并用 `cordis_inspect_query`
（host:`Service`）核对过线上服务：

| 能力        | 实际签名                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| 取/恢复会话 | `ctx.sessionController.resolveAgent(id): Promise<{agent} \| {error}>`                                                |
| 建会话      | `ctx.sessionController.create({ sessionId?, workspaceId?, cwd?, agentPreset? }): Promise<{sessionId, agentPreset?}>` |
| 改名        | `ctx.sessionController.rename({ sessionId, title }): Promise<{title, seq}>`                                          |
| 工作区      | `ctx.workspaceRegistry.create(path, title?): Promise<Workspace>`（**路径必须已存在**）                               |
| 权限        | `ctx.permissionPresets.set(session, name): void`（同步，未知名字抛错）                                               |
| 活动 Agent  | `ctx.agents.get(SessionId): Agent \| undefined`                                                                      |
| 会话事件    | `ctx.on('session/event', (session, event) => void)`                                                                  |
| 投递        | `agent.followup(msg)` / `agent.steer(msg)` / `agent.inject(msg)`，`msg` 由 `freezeMessage` 冻结                      |
| 取消        | `agent.cancel(cause: {kind:'hook',reason}, { keepInbox?: boolean }): void`                                           |
| 消息 id     | `MessageId(id: string)`；`MessageSourceMap` 可 `declare module` 扩展                                                 |
| 系统提示    | `agent.ctx.systemPrompt.section({ name, order, text, interpolate?, complete? }): () => void`                         |
| 检索        | `ctx.web.search({ query, maxResults? }, signal?): Promise<{content?, sources, truncated}>`                           |
| 回合事件    | `turn/end` 的 `data` 是 `{ turn, reason }`；`reason.kind ∈ completed \| aborted \| blocked \| failed`                |
| 最终文本    | 最后一条 `assistant/message` 的 `data.message.content` 里的 text 块                                                  |

与任务书/原型有差异、需要记录的地方：

1. **`agent.interrupt/abort/stop` 都不存在**。中断回合并清空队列的唯一入口是
   `agent.cancel(cause, { keepInbox: false })`；`ctx.sessionController.cancel({sessionId})`
   只中止当前回合，**不清空** inbox，因此没有采用。
2. **`sessionController.prompt()` 存在但不适合本插件**：它的 `requestId` 是品牌类型且会把消息
   标成 `user-rpc`（看起来像主人手写），所以仍用 `freezeMessage` + `agent.followup`，source 为
   `dsh-whale-chan`。
3. **`workspaceRegistry.create` 要求目录已存在**（相对路径、不存在、非目录都会被拒）。因此
   `ensureSession` 先 `mkdir -p` 再注册工作区；这一点原型没有体现。
4. **没有公开的「关闭 Agent/Session」API**（`ctx.agents` 只有 `get/list/roots/create/resume/register/...`）。
   回复器的「重建」实现为：取消旧会话当前回合 → 不再引用它 → 用同一身份再 `create`，
   当同名会话已经开始过回合时 DSH 会**另发**一个 sessionId（`SessionCreateValue.sessionId`）
   并返回，`SessionModel` 采纳返回值。
5. **幂等不需要 `sessionPersistence`**：`agent.session.snapshotEvents()` 已包含恢复出来的历史，
   查重是同步的，且重启后仍成立。
6. **preset 里的插件包不是本包的依赖**：`@deepseek-ai/dsh-persona`、`dsh-time-context`、
   `dsh-tool-web` 等都随 DSH 发布（读 `app.asar` 头可确认 `dsh/node_modules/@deepseek-ai/<pkg>`
   存在），patch 里只写包名，与 DSH 自带的 `minimal`/`standard` preset 写法一致。

| 模型选择 | `ctx.llm.resolveCallConfig({provider, model, reasoningEffort?})` |
| 会话事件写入 | `agent.session.append('model/selection', selection)`；`model/selection` 由 `dsh-api-session-controller` 扩展进 `SessionEventMap` |
| 首个请求注入 | `agent.ctx.on('system-prompt/assemble', …, { prepend: true })` + `agent.ctx.on('agent/request', …, { prepend: true })` |
| 持久化确认 | `ctx.sessionPersistence.flush()` |

## 4. 关键决策

| 决策                         | 选择                                                         | 理由                                                                    |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 批准门位置                   | 执行器入口再查一次任务/批准/归属                             | 领域校验挡不住「错配的派工记录」；多一次检查不建任何东西                |
| 结局 happens-before 会话存在 | 会话前失败直接抛，不回调                                     | 领域没有 running 的东西可以结束，凭空 `assignmentEnded` 会污染状态机    |
| `summary` 来源               | 只取最后一条 assistant 文本                                  | 空串是事实；补一句「已完成」会让面板骗人                                |
| 超时                         | `host.cancel` 取消回合 + 返回 `timeout`                      | 不 SIGKILL、不留下继续跑的会话                                          |
| 取消                         | 先 abort 自己的 lifetime，再 `agent.cancel(keepInbox:false)` | 保证判定为 `cancelled` 而不是 `failed`，且不会被残留队列唤醒            |
| 外部停止回合                 | 上报 `failed`                                                | 别人的操作不该被记成本插件的取消                                        |
| 幂等                         | 消息 id = `dsh-whale-chan:<requestId>`，查会话日志+inbox     | 无额外账本，重启后仍成立                                                |
| 回合匹配                     | 按投递消息所在的回合号匹配 `turn/end`                        | 「任意 turn/end」会把他人的回合当成自己的结束（有变异测试）             |
| 复查竞态                     | 先订阅、后扫历史、补放扫描期间事件                           | 避免「订阅前刚结束」的回合被漏掉                                        |
| 回复器复用                   | 20 轮或空闲 30 分钟重建                                      | 长会话不能无界增长；重建前先取消旧回合                                  |
| 提示预算                     | 12000 码点，先丢最旧消息，system 永不丢                      | 人设与安全规则比历史更重要                                              |
| 检索失败                     | 一律空结果 + 一行 warn                                       | brain 的降级路径就是「当作没搜到」，不该抛到调用方                      |
| worker 系统提示              | agent 级 `systemPrompt.section`（非 complete）               | preset 的 persona/指令段保留，本段追加在后                              |
| 单回合上限                   | 90 秒（`MODEL_TURN_TIMEOUT_MS`，两角色共用）                 | 本机模型首 token 15–30 秒；60 秒会把健康但慢的回合误判为超时（T3 实测） |
| 任务总预算                   | `tasks.timeoutMinutes`，但不低于一个回合                     | 总预算可以更长；只有「1 分钟任务」这种配置需要下限保护                  |
| 回复器 preset 含 tool-web    | 按任务书保留（`fetch:false`）                                | 与宿主检索预算对齐；写文字的安全边界由「无 shell/fs」保证               |
| 工作区优先级                 | `Assignment.workspace` 优先，缺省用设置                      | 人选的目录必须就是任务目录；设置只是「没选」时的默认                    |
| 相对路径工作区               | 拒绝（`UserError('invalidWorkspace')`）                      | 用户可纠正的输入错误；由领域承载后 API 才能与其他拒绝统一映射           |
| 重试会话                     | 新会话（id 带派工后缀）                                      | 领域把重试当新派工；复用失败会话会把上一次的错误上下文带进来            |
| 重试上下文                   | 消息里附「上一轮结果（供参考）」                             | 新会话看不到历史，唯一能避免重复劳动的信息就是上次的结论                |
| 模型路由来源                 | 每个角色各用 `settings.models.*`，不改全局默认               | `selectModel` 会改全局默认，回复路由会污染所有新会话                    |
| 模型路由时机                 | 会话首次创建后、首个回合前写入；已有选择不覆盖               | 主人后来在面板换的模型必须赢                                            |
| preset 人设前缀              | 中性一句，身份交给动态人设段                                 | 硬编码名字会在主人改名后与设置里的人设冲突                              |
| 宿主入口                     | 不导出执行器                                                 | 否则插件加载即把 `dsh-llm`/`dsh-session` 拉进模块图，即使从不跑任务     |

## 5. 测试

- 新增 **104** 条：`executor-task` 31、`executor-model` 21、`executor-role-model` 12、
  `executor-research` 10、`executor-session` 13、`presets` 17。仓库总数 335 → **439**。
- 5 个变异实验全部被杀死：关掉批准门（3 条失败）、回合匹配改成「任意 turn/end」（3 条）、
  去掉按 thread 的互斥（1 条）、忽略提示预算（3 条）、`onFinished` 重复调用（3 条）。
- `DshSessionHost` 无法在单测里真跑（会真的建会话并呼唤模型），因此它的验证方式是
  ①`tsc` 对着安装包声明做类型检查；②`TurnTracker`/`awaitTurn` 这两个纯逻辑被 13 条测试覆盖；
  ③本文件与 `docs/test-reports/WS4.md` 记录每条被调用的签名。
- preset 测试用 `yaml` 解析真实文件，断言宿主行仍在、两套 preset 的 id/name/order/插件集、
  回复器无 shell/fs/jobs/skill、执行器有 shell（平台二选一）/fs/jobs/web/todo、无重复 id。

## 6. 影响面与风险

- `src/index.ts` 未改：执行器只在 `src/executor/index.ts` 导出，由 WS5 的组合根显式 import。入口 bundle 因此保持
  19.94 kB（`lib/index.d.ts` 0.75 kB），不再包含执行器，也不 import `@deepseek-ai/dsh-llm`／`dsh-session`。
- 新增 devDependency `yaml`（仅测试解析用），runtime 依赖仍是 `cross-spawn`、`proper-lockfile`、`zod`。
  构建产物外部 import 只有 `zod`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、
  `@deepseek-ai/dsh-session` 与 Node 内置（声明在 peerDependencies）。
- 风险 1：worker 会话的权限来自设置，若被设成 `danger-full-access`，提示词注入的危害面会变大。
  代码只做「非法值回退到 `workspace-write`」，不能替代主人的判断。
- 风险 2：重试是**新会话**，只通过任务消息里的「上一轮结果（供参考）」继承上下文；上一次的其余对话不会带过去。
  这是刻意的（重试应当是干净环境），代价是 worker 需要重新读工作区。
- 风险 3：两套 preset 依赖 DSH 随包插件。DSH 大版本升级改名时要同步改 patch（测试会立刻发现
  名字不合语法，但不会发现「包被改名」）。
- 风险 4：回复器会话按 thread 复用 DSH 历史；如果主人把同一个 thread 交给两个进程，两个进程会
  各自建会话（DSH 的 writer 锁会让第二个 `create` 走新身份），不会互相踩，但也不共享历史。
- 风险 5：模型路由只在会话首次创建时写入。若主人在设置里改了 `models.worker`，已有会话仍用旧路由，
  直到该任务的下一次派工（新会话）才生效；回复器则在下次轮数/空闲重建时生效。

## 7. 已知缺口

- `DshSessionHost` 没有单元测试（需要真实 DSH 宿主）；错误分支（`resolveAgent` 返回 error、
  `rename` 失败）只有类型级保护。
- 没有实现代码里的并发上限（`tasks.maxConcurrent` 属 WS5 调度）；执行器只保证同一任务不并发。
- 没有把任务产物路径写进 `ExecutorResult`：领域 `TaskResult.artifactPaths` 由 WS5 从工作区扫描补。
- `SessionModel` 的重建是「重建会话」而不是「压缩历史」；DSH 的 compaction 在 preset 里，但
  本层不主动触发。
- 未做真实端到端演练（需要钉钉消息 + 真模型），留给 WS8。

## 8. 自评（审核清单）

| #   | 项目                            | 结论                                                                      |
| --- | ------------------------------- | ------------------------------------------------------------------------- |
| ①   | 无批准绝不建会话                | `assertApproved` 在 `mkdir` 之前；3 条测试 + 变异 M1 被杀死               |
| ②   | 投递幂等、无重复回合            | 消息 id 派生自 requestId，投递前查日志与 inbox；模型层 requestId 每次递增 |
| ③   | 超时/取消/失败都恰好一次回调    | `finally` + `started` 标志；变异 M5（重复回调）被杀死                     |
| ④   | 会话复用不串话                  | 按 `SessionRef` 寻址；回复器按 thread 串行；变异 M3（去互斥）被杀死       |
| ⑤   | preset 用真实字段且依赖包存在   | 与 DSH 自带 preset 同构；包名在 `app.asar` 中逐个确认；17 条 preset 测试  |
| ⑥   | 模型/检索失败可被 brain 映射    | `ModelTimeoutError.reason='timeout'` 等；检索失败返回空结果               |
| ⑦   | 不碰真实钉钉/模型               | 测试全部用 fake host / fake web；无网络、无子进程                         |
| ⑧   | API 实测而非猜测                | §3 的表格 + `tsc` + `cordis_inspect_query`                                |
| ⑨   | 文档整合 channel/brain/executor | `docs/007-architecture.md` 重写为统一整合点；`003`/`006` 同步             |
| ⑩   | 提交规范、工作区干净            | 见 §9；门禁输出见测试报告                                                 |

## 9. 提交

第一轮（初版实现，5 个提交）：

| 提交                                                | 内容                                         |
| --------------------------------------------------- | -------------------------------------------- |
| `feat(executor): session host and task executor`    | `types`、`errors`、`session-host`、`task`    |
| `feat(executor): replier model and research`        | `model`、`research`、`index`、`src/index.ts` |
| `feat(preset): replier and worker presets`          | `cordis.patch.yml`、`package.json`、lock     |
| `test: cover executor, model, research and presets` | 5 个 spec + fixture                          |
| `docs: execution, architecture and deployment`      | 003/007/006 与本文、测试报告                 |

第二轮（审核整改，5 个提交）：

| 提交                                                            | 内容                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `fix(executor): honour approved workspace and fresh retries`    | 批准目录优先、相对路径拒绝、派工后缀会话、上一轮结果；`src/index.ts` 不再导出执行器 |
| `feat(executor): seed role models from settings`                | `role-model.ts`、宿主播种、`SessionModel` 的 reply 路由                             |
| `feat(preset): neutral persona prefix`                          | 两套 preset 的中性人设前缀                                                          |
| `test: cover approved workspace, role models and fresh retries` | 新增 `executor-role-model.spec.ts`、工作区/路由/前缀/重试断言（+21 条）             |
| `docs: approved workspace, model routes and smoke test`         | 003/006/007 与本文、测试报告                                                        |

第二轮按「代码 → preset → 测试 → 文档」排序：前三个提交各自 `pnpm typecheck` 通过，但由于
会话 id 与断言同批改动，测试文件在 `test:` 提交之前会失败（这是提交切分的代价，最终 HEAD 全绿）。

分支未合并、未 push；`pnpm check`、`check-pack`、`git status` 结果见
[WS4 测试报告](../test-reports/WS4.md)。
