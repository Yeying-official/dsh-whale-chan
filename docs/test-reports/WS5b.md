# WS5b 测试报告

- 环境：Windows，Node `v24.15.0`，pnpm `11.4.0`，vitest `4.1.8`
- 分支：`feat/ws5b-pipeline`（从 `main` `8dc9b93` 创建）
- 范围：outbound follow-up 生命周期、持久计数器、8 种 effect handler、组合根、暂停/恢复、健康、过期/probe/outbox 恢复
- 不接触：真实 `dws`、模型、网络、DSH 会话；所有外部能力在测试中注入 fake

## 1. 门禁命令与真实输出

```text
$ pnpm install --frozen-lockfile
Packages: +239
...
Done in 47.8s using pnpm v11.4.0

$ pnpm typecheck
$ tsc --noEmit
（无输出，退出码 0）

$ pnpm test
 Test Files  58 passed (58)
      Tests  692 passed (692)

$ pnpm build
ℹ [CJS] lib\client.js  222.76 kB │ gzip: 46.31 kB
ℹ [CJS] 1 files, total: 222.76 kB
✔ Build complete
ℹ [ESM] lib\index.js  315.53 kB │ gzip: 87.67 kB
ℹ [ESM] lib\index.d.ts    0.90 kB │ gzip:  0.43 kB
ℹ [ESM] 2 files, total: 316.43 kB
✔ Build complete

$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!

$ node scripts/check-pack.mjs
pack check passed: 15 artifacts, icon 711 bytes

$ git status --porcelain
（无输出）
```

## 2. 测试增量

WS5b 自身新增 6 个 spec、70 条用例。合并 `main` `ff90f79`（WS2 T3 + WS4 直连 + WS6）后全量为 58 个 spec、**692** 条。

| 文件                             | 条数 | 覆盖                                                                                                                                                                                                                                                           |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/core-outbound.spec.ts`    | 10   | `queueFollowup` 落库/事件/`at`；同键去重；线程不存在、目标 kind 不符、空文本/空键；sent 回执；unknown/failed/dropped 终态保护                                                                                                                                  |
| `tests/rate-counters.spec.ts`    | 11   | 窗口滚动、写入裁剪、跨 store 实例、gap、损坏 JSON 恢复；最近 outbound、连续回复清零、dm/group target、broadcast、20 条窗口                                                                                                                                     |
| `tests/pipeline-chat.spec.ts`    | 18   | 自动回复端到端、重复投递不重复回复、无目标 defer；review/自动关闭/静默/限速/最小间隔；未 @/广播/回声；低置信/空回复；检索成功与降级；unknown/failed/skipped 发送                                                                                               |
| `tests/pipeline-task.spec.ts`    | 7    | GET tasks 可见待批准、批准后 fake executor 执行/`assignmentEnded`/回帖文本与目标；未批准、取消后残留 launch、派工不符不执行；失败只 notice；DM 回帖目标                                                                                                        |
| `tests/runtime-pipeline.spec.ts` | 20   | 授权门（未登录/token 失效/无 owner）、模板失败、通道启动失败；暂停/恢复、targets 防抖、dws 重启、persona/models 重建；outbox 恢复与幂等；expire/probe pass；停机顺序、幂等、锁/db 释放；ownerNick 透传；不再构造 SessionModel；`inject` 含 `agentDefaultModel` |
| `tests/health-view.spec.ts`      | 4    | channel 健康语义：monitoring disabled / paused / 无 enabled target 均 ok；有 enabled target 但 stopped 为 degraded；overall 不被 idle 拖成 degraded                                                                                                            |

既有 `tests/core-invariants.spec.ts` 的错误码分类表补入 3 个新码（`emptyOutbound`、`emptyIdempotencyKey`、`outboundTargetMismatch`，均为 `invalid`）。

## 3. 关键断言

- **owner 未知绝不启动订阅**：未登录、token 失效、无账号 id 三种情况 `channel.startCalls === 0`，`health.status === 'error'`，`auth` check 的 `detail` 说明原因。
- **unknown 绝不重发**：`send` 返回 unknown 后 Decision=`send_unknown`、Outbound=`unknown`，再跑一次 `effects.idle()` 通道仍只收到 1 条。
- **review 不自动发送**：目标 `replyMode=review`、`autoReply=false`、静默时段、限速、最小间隔都只产生 `drafted`，`channel.sends` 为空。
- **任务无批准绝不 launch**：待批准任务上的 launch 行不调用执行器；取消后残留 launch 同样不执行；payload assignmentId 不符也只写 notice。
- **结果只回报成功**：failed 执行只写 `task_failed` notice，不产生 Outbound；succeeded 产生一条 `kind:'reply'` 的 follow-up，文本包含任务标题、摘要与会话 id。
- **效果可恢复**：崩溃窗口里留下的 pending follow-up 在 `resumeOutbox()` 后发送；重复 resume 不产生第二条。
- **暂停/恢复无泄漏**：paused=true 后 `monitor.running=false` 且 `channel.stopCalls=1`；恢复后重新 start。
- **停止顺序**：`channel:stop → executor:dispose → model:dispose`；`stop()` 两次返回同一 Promise；锁释放、数据库关闭。
- **健康真实值**：`monitor.running`、`channel`、`auth`、`prompts`、`effects`、`executor` 均由运行时状态投影；暂停显示为 channel `ok` 的「paused by the owner」。
- **channel idle 不再误报**：monitoring disabled → `ok`「monitoring is disabled in settings」；paused → `ok`；无 enabled target → `ok`「idle: no enabled targets」；只有有 enabled target 却 stopped 才是 `degraded`；四种状态都不会把 overall 拖成 degraded。
- **ownerNick 透传**：`probeAuth()` 返回 `userName` 时，运行通道收到 `ownerNick`（fake 工厂捕获 `{userId:'owner-1', ownerNick:'鲸鱼酱'}`）；auth 不返回时不伪造该键；`ownerUserId`/`ownerKnown` 不受影响，`ownerNick` 不进 health/auth 状态。
- **回复直连 LLM**：`src/app/runtime.ts` 不再 import/构造 `SessionModel`；`models.reply` 变化时重建 `LlmModel`，`persona` 变化不触发任何模型重建（`resetCalls=0`）。
- **日志/健康不含敏感正文**：notice 只有 kind 与 id；channel 启动错误只保留 `name:code`；health 不包含账号 id、token 或消息正文。

## 4. 自评（10 条审核清单）

| #   | 项                     | 结果                                                                                       |
| --- | ---------------------- | ------------------------------------------------------------------------------------------ |
| ①   | owner 未知绝不启动订阅 | ✅ runtime 授权门 + channel 自身 owner-unknown 双重拦截                                    |
| ②   | unknown 绝不重发       | ✅ `send` 只处理 pending；unknown 立即终态；resume 只读 pending                            |
| ③   | review 草稿不自动发送  | ✅ gate `mode:'review'` 只 draft，无 send effect                                           |
| ④   | 任务无批准绝不 launch  | ✅ launch 重查 task/approval/assignment/payload；失败只 notice                             |
| ⑤   | 效果幂等/可恢复        | ✅ 每个 handler 重读状态；send/launch/finish 均可重放；outbox resume                       |
| ⑥   | 暂停/恢复无泄漏进程    | ✅ channel.stop 等待子进程收敛；恢复重新 start；测试记录 stop/start 次数                   |
| ⑦   | 停止顺序无挂起         | ✅ drain→channel→executor→model→passes→host→lock/db，可重复调用                            |
| ⑧   | 健康真实反映           | ✅ 真实 channel/auth/prompts/effects/executor；API-only 模式保持 unknown 不误报            |
| ⑨   | 日志无敏感正文         | ✅ 稳定原因码/名称；notice 仅 id；health 无账号 id/token/正文                              |
| ⑩   | 测试能杀死错误实现     | ✅ 反例覆盖未登录、无 owner、未批准、取消后 launch、unknown、review、降级检索、重复 resume |

## 5. 已知限制

- **无历史补拉**：WS2 没有 backfill 能力，本期不伪造历史消息。
- **通知不进 DSH 收件箱**：`notify` 只写 `notice` 审计事件；unknown/failed 需人工对账。
- **单实例**：状态目录锁；第二个实例启动失败，不自动排队。
- **review 无确认发送路由**：v1 只生成草稿。
- **未做真实 dws/DSH 冒烟**：属于 WS8；本报告的门禁全部在 fake 上完成，`DshSessionHost`/`DingTalkChannel` 由既有类型声明与 WS2/WS4 测试覆盖。
