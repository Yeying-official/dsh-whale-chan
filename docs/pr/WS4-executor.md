# WS4 · 任务执行器、回复器会话与 agent preset

- 分支：`feat/ws4-executor`（从 `main` `6fcacb0` 创建）
- 范围：`src/executor/**`、`src/index.ts`（仅新增一条 `export *`）、`cordis.patch.yml`（追加两套 preset）、
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

| 文件                           | 职责                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `src/executor/types.ts`        | `ExecutorRequest/Result`、`SessionHost`、`TaskExecutor`、preset 常量与 id 派生               |
| `src/executor/errors.ts`       | `ExecutorError` 与 `ModelTimeoutError`/`ModelAbortedError`/`ModelFailedError`（带 `reason`） |
| `src/executor/session-host.ts` | `DshSessionHost`（DSH 适配）、`TurnTracker`（回合匹配）、`awaitTurn`（超时/中止等待）        |
| `src/executor/task.ts`         | `DshTaskExecutor`：批准门、工作区、系统提示、投递、结局映射、取消、并发                      |
| `src/executor/model.ts`        | `SessionModel implements ModelPort`：按 thread 复用会话、串行、轮数/空闲重建、提示组装       |
| `src/executor/research.ts`     | `DshResearch implements ResearchPort`：`ctx.web.search` 适配与降级                           |
| `src/executor/index.ts`        | 公开出口                                                                                     |
| `cordis.patch.yml`             | `dsh-whale-chan-replier-preset`、`dsh-whale-chan-worker-preset`                              |

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

## 4. 关键决策

| 决策                         | 选择                                                         | 理由                                                                 |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| 批准门位置                   | 执行器入口再查一次任务/批准/归属                             | 领域校验挡不住「错配的派工记录」；多一次检查不建任何东西             |
| 结局 happens-before 会话存在 | 会话前失败直接抛，不回调                                     | 领域没有 running 的东西可以结束，凭空 `assignmentEnded` 会污染状态机 |
| `summary` 来源               | 只取最后一条 assistant 文本                                  | 空串是事实；补一句「已完成」会让面板骗人                             |
| 超时                         | `host.cancel` 取消回合 + 返回 `timeout`                      | 不 SIGKILL、不留下继续跑的会话                                       |
| 取消                         | 先 abort 自己的 lifetime，再 `agent.cancel(keepInbox:false)` | 保证判定为 `cancelled` 而不是 `failed`，且不会被残留队列唤醒         |
| 外部停止回合                 | 上报 `failed`                                                | 别人的操作不该被记成本插件的取消                                     |
| 幂等                         | 消息 id = `dsh-whale-chan:<requestId>`，查会话日志+inbox     | 无额外账本，重启后仍成立                                             |
| 回合匹配                     | 按投递消息所在的回合号匹配 `turn/end`                        | 「任意 turn/end」会把他人的回合当成自己的结束（有变异测试）          |
| 复查竞态                     | 先订阅、后扫历史、补放扫描期间事件                           | 避免「订阅前刚结束」的回合被漏掉                                     |
| 回复器复用                   | 20 轮或空闲 30 分钟重建                                      | 长会话不能无界增长；重建前先取消旧回合                               |
| 提示预算                     | 12000 码点，先丢最旧消息，system 永不丢                      | 人设与安全规则比历史更重要                                           |
| 检索失败                     | 一律空结果 + 一行 warn                                       | brain 的降级路径就是「当作没搜到」，不该抛到调用方                   |
| worker 系统提示              | agent 级 `systemPrompt.section`（非 complete）               | preset 的 persona/指令段保留，本段追加在后                           |
| 回复器 preset 含 tool-web    | 按任务书保留（`fetch:false`）                                | 与宿主检索预算对齐；写文字的安全边界由「无 shell/fs」保证            |

## 5. 测试

- 新增 **78** 条：`executor-task` 23、`executor-model` 17、`executor-research` 10、
  `executor-session` 13、`presets` 15。仓库总数 335 → **413**。
- 5 个变异实验全部被杀死：关掉批准门（3 条失败）、回合匹配改成「任意 turn/end」（3 条）、
  去掉按 thread 的互斥（1 条）、忽略提示预算（3 条）、`onFinished` 重复调用（3 条）。
- `DshSessionHost` 无法在单测里真跑（会真的建会话并呼唤模型），因此它的验证方式是
  ①`tsc` 对着安装包声明做类型检查；②`TurnTracker`/`awaitTurn` 这两个纯逻辑被 13 条测试覆盖；
  ③本文件与 `docs/test-reports/WS4.md` 记录每条被调用的签名。
- preset 测试用 `yaml` 解析真实文件，断言宿主行仍在、两套 preset 的 id/name/order/插件集、
  回复器无 shell/fs/jobs/skill、执行器有 shell（平台二选一）/fs/jobs/web/todo、无重复 id。

## 6. 影响面与风险

- `src/index.ts` 只新增 `export * from './executor/index.ts'`，`apply()` 未改；执行器不会被自动创建。
- 新增 devDependency `yaml`（仅测试解析用），runtime 依赖仍是 `cross-spawn`、`proper-lockfile`、`zod`。
  构建产物外部 import 只有 `zod`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、
  `@deepseek-ai/dsh-session` 与 Node 内置（声明在 peerDependencies）。
- 风险 1：worker 会话的权限来自设置，若被设成 `danger-full-access`，提示词注入的危害面会变大。
  代码只做「非法值回退到 `workspace-write`」，不能替代主人的判断。
- 风险 2：`whale-task-*` 会话会被复用（同一任务重试沿用同一会话），worker 能看到上一次的上下文。
  这是刻意的（重试通常需要前情），但意味着重试不是干净环境。
- 风险 3：两套 preset 依赖 DSH 随包插件。DSH 大版本升级改名时要同步改 patch（测试会立刻发现
  名字不合语法，但不会发现「包被改名」）。
- 风险 4：回复器会话按 thread 复用 DSH 历史；如果主人把同一个 thread 交给两个进程，两个进程会
  各自建会话（DSH 的 writer 锁会让第二个 `create` 走新身份），不会互相踩，但也不共享历史。

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
| ⑤   | preset 用真实字段且依赖包存在   | 与 DSH 自带 preset 同构；包名在 `app.asar` 中逐个确认；15 条 preset 测试  |
| ⑥   | 模型/检索失败可被 brain 映射    | `ModelTimeoutError.reason='timeout'` 等；检索失败返回空结果               |
| ⑦   | 不碰真实钉钉/模型               | 测试全部用 fake host / fake web；无网络、无子进程                         |
| ⑧   | API 实测而非猜测                | §3 的表格 + `tsc` + `cordis_inspect_query`                                |
| ⑨   | 文档整合 channel/brain/executor | `docs/007-architecture.md` 重写为统一整合点；`003`/`006` 同步             |
| ⑩   | 提交规范、工作区干净            | 见 §9；门禁输出见测试报告                                                 |

## 9. 提交

| 提交                                                | 内容                                         |
| --------------------------------------------------- | -------------------------------------------- |
| `feat(executor): session host and task executor`    | `types`、`errors`、`session-host`、`task`    |
| `feat(executor): replier model and research`        | `model`、`research`、`index`、`src/index.ts` |
| `feat(preset): replier and worker presets`          | `cordis.patch.yml`、`package.json`、lock     |
| `test: cover executor, model, research and presets` | 5 个 spec + fixture                          |
| `docs: execution, architecture and deployment`      | 003/007/006 与本文、测试报告                 |

分支未合并、未 push；`pnpm check`、`check-pack`、`git status` 结果见
[WS4 测试报告](../test-reports/WS4.md)。
