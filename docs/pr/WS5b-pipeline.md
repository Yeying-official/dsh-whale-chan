# WS5b · 流水线与宿主运行时

- 分支：`feat/ws5b-pipeline`（从 `main` `8dc9b93` 创建）
- 范围：`src/app/{runtime,views,counters,thread-state,pipeline,effects-chat,effects-task,channel-runtime,brain-ports,dingtalk-channel}.ts`、
  `src/core/{engine,errors,ports}.ts`、`src/index.ts`、
  `tests/{core-outbound,rate-counters,pipeline-chat,pipeline-task,runtime-pipeline}.spec.ts`、
  `tests/fixtures/pipeline.ts`、`tests/core-invariants.spec.ts`、
  `docs/{003,006,007}`、`docs/pr/WS5b-pipeline.md`、`docs/test-reports/WS5b.md`
- 不做：UI（WS6）、`src/client`、`src/channel|brain|executor` 的行为、`src/shared`、`package.json`、`docs/PROGRESS.md`；未合并、未 push、未安装 profile

## 1. 目标

1. 把已交付的 core/store/settings/effects/channel/brain/executor 组合成真实宿主运行时；
2. 打通「收消息 → 分类 → 策略 → 检索/草稿 → 发送」；
3. 打通「任务 → 批准 → 执行 → 回报」；
4. 补暂停/恢复、健康、过期清扫与崩溃恢复；
5. 不改 UI，只把后端真相接到冻结的 HTTP 合约。

## 2. 领域补全：独立 outbound 生命周期

`Outbound` 不再只能由 Decision 产生：

- `Engine.queueFollowup({ threadKey, target, text, idempotencyKey, kind, outboundId }, { at? })`
  - 线程必须存在；`target.kind` 必须等于线程 kind；文本与幂等键非空；
  - 同键重复入队返回既有 Outbound，不产生第二条外部消息；
  - 落库 `pending`，emit `outbound.queued`。
- `outboundSent(id, receipt?)` / `outboundUnknown(id, error)` / `outboundFailed(id, error)` / `outboundDropped(id, reason)`：
  - 只更新 Outbound，不碰 Decision；
  - 只处理 `pending`，重复上报/迟到上报不改变终态；
  - attempts 只在 unknown/failed 时 +1。
- `pendingOutbounds()` 直接读 repository；`Repositories` 未改。
- 新错误码：`emptyOutbound`、`emptyIdempotencyKey`、`outboundTargetMismatch`（均为 `invalid`）。

`tests/core-outbound.spec.ts` 10 条覆盖幂等键、目标不匹配、未知线程、重复结果与终态保护。

## 3. 计数器与防环（`src/app/counters.ts`、`thread-state.ts`）

- `KvCounterStore`：把每线程时间戳数组存进 `kv` 的 `rate:<threadKey>`，写入时裁剪窗口；`hit` 返回窗口内计数，另提供 `count`/`gapMs` 与 `readGateCounters`。
- 持久化：重启后仍知道最近一小时的回复次数与最小间隔；损坏 JSON 按空计数恢复（安全侧）。
- `thread-state.ts`：最近 20 条消息窗口、最近 outbound 文本（`isEcho`）、连续 AI 回复数（比最近一条入站时间晚的已发送 outbound 数）、线程投递目标、broadcast 推导。
- 测试：窗口滚动、裁剪、跨实例、gap、损坏恢复、窗口/自我标记（11 条）。

## 4. Effect 流水线

注册 8 种 handler（详见 [007 §5.1](../007-architecture.md)）：`classify`、`research`、`compose`、`send`、`launch`、`finish`、`probe`、`notify`。

### 4.1 回复链

- `classify`：读取 decision/message/thread，把 `InboundMessage` 映射为 `BrainMessage`（broadcast 由 mentions/@所有人 推导），带 20 条窗口调用 `SessionModel.forThread(...)`；失败/超时/低置信 → `engine.defer(decisionId, 'classify:<reason>')`。
- task：`engine.classify(..., { intent:'task', task, approvalTtlMs })` 后写一条 `notice` 审计事件并结束；`tasks.enabled=false` 时 defer。
- question + `need_search` → `research`，否则 chat → `compose`。
- `research`：`research()`（brain 预算/缓存）包住注入的 `ResearchPort`；失败/降级也把 `ResearchResult` 交给 `compose`（无引用、无链接）。
- `compose`：`gateReply`（settings/message/thread/now/counters/loop）；`act:false` → defer；`review` → 只 `engine.draft`；`auto` → draft + `engine.queueReply` + enqueue `send`。组合失败 → defer。
- `send`：`channel.sendWithReceipt(outbound)`；`sent` → `replySent`/`outboundSent` + `counter.hit`；`unknown` → `replyUnknown`/`outboundUnknown` + `notice`，**绝不自动重发**；`failed`/`gone` → 失败终态 + notice；`skipped` → 无操作（dryRun 留 pending）。
- 回声：`isEcho(message.text, recentOutboundTexts)` → defer `echo`。

### 4.2 任务链

- `launch`：校验 task exists、`approved`、approval `approved` 且属于该 task、assignment `pending` 且匹配 payload；`tasks.maxConcurrent` 达到上限抛 `Later`（1 s 重试）；`executor.execute({ task, approval, settings, workspace, signal })`。
- 执行器回调：`onStarted → engine.assignmentStarted(..., { sessionId })`，`onFinished → engine.assignmentEnded(..., { outcome, result })`。
- 成功 → enqueue `finish`；失败/超时/取消 → 只写 `notice`。
- `finish`：`queueFollowup` 到原线程，target 由线程与最近一条消息推导（dm → peerUserId，group/at-me → conversationId），文本为「任务标题 + 摘要 + 会话 id」，幂等键 `task-finish:<taskId>:<assignmentId>`，再 enqueue `send`。
- `notify`：v1 只写 `notice` 审计事件，不建 DSH 回话。
- `probe`：pass 调用组合根的 `probe()`；授权失效立即停通道并让 health 变红。

## 5. 组合根（`src/app/runtime.ts`）

- 保持 WS5a 的 `Runtime(config, options)` 入口，新增 `options.ctx` 与 `options.overrides`（channel/model/research/executor/sessionHost/prompts/settings/command/baseArgs/env）与定时器 seam。
- 启动：存储 → 设置种子 → 模板预载 → 执行器/模型/检索/流水线装配 → 授权探测 → `Effects.start` → `Passes.start` → 通道启动 → outbox 恢复。
- 授权门：`available && authenticated && tokenValid && userId`；缺一不订阅。无 owner 的探测通道用于 `probeAuth()`，成功后再以 owner 构造运行通道。
- 设置热应用：persona → 重建 replier；models → 更新路由并重建；monitor → 立即 reconcile；targets/dws → 500 ms 防抖重启。
- 健康：`status()` 提供真实 `monitorRunning`、channel state/targets/error、auth 布尔、effects pending/dead、executor active、prompts ready/error；`healthView` 将它们映射为 checks，`overview.monitor.running` 不再写死。通道 `disabled`/`paused`/无 enabled target 均投影为 `ok`（idle），只有应有订阅却 `stopped` 才 `degraded`。
- 停止顺序：`effects.drain → channel.stop → executor.dispose → model.dispose → passes.stop → host.dispose → 释放锁/关闭 db`，可重复调用。
- `src/index.ts`：`inject` 增加 `agents`/`sessionController`/`workspaceRegistry`/`permissionPresets`/`sessionPersistence`/`llm`/`web`（`systemPrompt` 经 agent context 访问，不注入），`new Runtime({ ctx, config })`（生产入口；旧 `(config, options)` 标注 `@deprecated`，仅供无 ctx 的 API 测试），`ctx.effect` 注册 `stop`。

## 6. Passes

- `expire`：60 s + 启动即跑，`engine.expireTasks(now)`。
- `probe`：5 min，调用 `probe()` → 更新 auth/health；登录恢复后重启通道。
- `outbox-resume`：启动/通道启动时把 `pending` Outbound 重新 enqueue `send`；无 backfill（v1 缺省）。

## 7. 测试

新增 6 个 spec、66 条用例（基线 496 → 562）：

| 文件                             | 条数 | 覆盖                                                                         |
| -------------------------------- | ---- | ---------------------------------------------------------------------------- |
| `tests/core-outbound.spec.ts`    | 10   | follow-up 幂等、目标匹配、空值、终态与重复上报                               |
| `tests/rate-counters.spec.ts`    | 11   | 窗口、裁剪、跨重启、gap、损坏、线程窗口/连续回复/目标/broadcast              |
| `tests/pipeline-chat.spec.ts`    | 18   | 自动回复、闸门 review/defer、检索、回声、unknown/failed/skipped              |
| `tests/pipeline-task.spec.ts`    | 7    | 待批准可见、批准执行回帖、未批准/取消/派工不符不执行、失败只通知             |
| `tests/runtime-pipeline.spec.ts` | 16   | 授权门、暂停/恢复、防抖重启、outbox 恢复、过期/probe pass、停机顺序          |
| `tests/health-view.spec.ts`      | 4    | disabled / paused / 无 enabled target / 有目标但 stopped 的 channel 健康语义 |

所有外部能力均为 fake：无真实 `dws`、模型、网络或 DSH 会话。

## 8. 提交

1. `feat(core): outbound follow-up lifecycle`
2. `feat(app): rate counters and effect pipeline`
3. `feat(runtime): compose channel, brain and executor`
4. `test: cover reply, task and runtime pipelines`
5. `feat(app): passes, pause and health`
6. `fix(app): write capture notices directly and accept the runtime initializer`
7. `docs: document the WS5b runtime`
8. `fix(app): report an idle channel as healthy`

## 9. 门禁

见 [WS5b 测试报告](../test-reports/WS5b.md)。未合并、未 push、未安装 profile。
