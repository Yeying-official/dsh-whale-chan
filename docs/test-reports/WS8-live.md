# WS8 真机验收报告

- 日期：2026-11-03（Asia/Shanghai）
- 分支：`feat/ws8-live`（真机修复已合并到 `main`；报告初版 `0ef660c`，T4 脱敏更新 `f43d7c3`）
- 环境：Windows、Node v24.15.0、DSH Desktop `0.2.1-rc.5`、profile `desktop`、`dws` v1.0.66（个人 OAuth）
- 账号：企业账号（本文不记录 corpId / userId / token），测试群为内部 5 人群（不记录完整 openConversationId）
- 范围：T0 认证与目标发现、T1 目标校验、T2 单条发送、T3 群内 @ 自动回复、T4 任务批准与执行
- 关联：[012 发布](../012-release.md)、[009 DWS 协议](../009-dws-protocol.md)、[007 架构](../007-architecture.md)

## 0. 结论

| 项                 | 结果           | 证据                                                                                                      |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------- |
| T0 认证与目标发现  | 通过           | `dws auth status` authenticated/token valid；`+chat-search` 命中测试群                                    |
| T1 目标校验        | 通过（修复后） | at-me 与群目标均 `valid:true`，未创建订阅                                                                 |
| T2 单条发送        | 通过（修复后） | `--yes` + AI 角标 + 幂等键；回执 `deliveryStatus=delivered`、`openMessageId`；同键第二次 `CONFLICT_ERROR` |
| T3 群内 @ 自动回复 | 通过（修复后） | 真实群事件 → 分类 → 会话式草稿 → 发送；outbound `sent`、receipt 已收到                                    |
| T4 任务批准与执行  | 通过           | `awaiting-approval` → 批准 → `running` → `succeeded`（约 18s）；产物文件与结果回复均验证                  |

真机验收同时暴露并修复了 5 个单测/桩无法发现的协议与契约问题（见 §3）。最终 T3 回复文本与 T4 结果回复均由 DSH 会话产生，交互过程可在会话 `钉钉 · <群名>` 中回看。

## 1. 验收步骤与结果

### T0 认证与目标发现

- `dws auth status -f json`：`authenticated=true`、`token_valid=true`、`refresh_token_valid=true`；`user_name` 用于 ownerNick（仅内存）。
- `dws chat +chat-search --query <群名> -f json`：唯一命中测试群，取 `openConversationId`。
- 结论：认证有效；群成员 5 人；目标 id 仅存本地临时文件，不提交、不打印完整值。

### T1 目标校验

- `POST /whale-chan/api/targets/validate`，请求含 at-me 与测试群两个目标。
- 首次失败：`dws` 返回 `invalid argument "1" for "--ttl" flag: time: missing unit in duration "1"`（exit 3）。
- 修复后两个目标 `valid:true`；校验只做 dry-run，不创建订阅，通道保持 `idle: no enabled targets`。

### T2 单条发送

- 首次失败：非交互环境缺 `--yes`，`dws` 返回 `confirmation_required`（exit 3）。
- 修复后：`--as user --chat-id <群> --markdown ... --ai-tag --idempotency-key <k> --wait-delivery --yes -f json` 成功。
- 真实回执：`{ conversationId, deliveryStatus: "delivered", idempotencyKey, openMessageId }`；同键第二次返回 `CONFLICT_ERROR`（`Request is repeated with uuid`），按 `unknown` 处理、不重发。

### T3 群内 @ 自动回复

- 触发：另一成员在测试群真实 @ 主人（非纯文本），通道订阅 `user_im_message_receive_group`。
- 真实扁平事件字段（`--flatten -f ndjson`）：`message_id`、`conversation_id`、`sender`（昵称）、`sender_open_dingtalk_id`、`content`、`event_time`、`create_time`；无 `staffId` / `atUsers` / `conversationType` / `title`。
- 处理链：归一化（`@<ownerNick>` 文本判定、按 openDingtalkId 标识发送者）→ 分类 → 会话式草稿 → 发送。
- 结果：decision `sent`；outbound `sent`，attempts 0，文本为鲸鱼酱人设的一句话自我介绍；回执 id 已收到。会话 `钉钉 · <群名>` 保留完整交互。

### T4 任务批准与执行

- 触发：另一成员 @ 主人并请求「在测试工作区创建 t4.txt，内容写 T4 ok」。
- 分类为 task → `awaiting-approval`；经 `POST /tasks/:id/approve` 批准 → `queued` → `running` → `succeeded`。
- 产物：`<stateDir>/tasks/<taskId>/t4.txt`，内容 `T4 ok`。
- 结果回复：outbound `sent`、receipt 已收到；首次文本含内部 `Route:` 与 `会话：whale-task-…`，验收中已修复——现只发面向发起人的完成摘要（见 §3 第 5 项）。

## 2. 真机与测试环境的差异

- 事件是 snake_case 扁平结构，且不含 `staffId`、`atUsers`、`conversationType`；@ 只能从 `content` 文本判断，白名单需按 `sender_open_dingtalk_id` 配置。
- 非交互发送必须显式 `--yes`；确认类错误与业务错误需要不同映射（failed / unknown）。
- 回复器会话带 141k 工具 schema（DSH 会话的完整工具目录），但模型实际 7–12 秒完成；**不能**据此把超时归因于工具 schema。
- 会话的 `user/message` 先于 `turn/start` 入队；投递 id 带 `dsh-whale-chan:` 前缀。等待回合必须按“先入队、后开回合”和“带前缀 id”匹配。

## 3. 真机暴露并修复的问题

| #   | 现象                           | 根因                                                                                               | 修复                                                                                                 |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | `targets/validate` exit 3      | `--ttl` 传裸数字，`dws` 要求 Go duration                                                           | `ttlDuration(hours) => "<hours>h"`，fake 与文档同步                                                  |
| 2   | 发送永远失败                   | 非交互缺 `--yes`                                                                                   | `buildSendArgs` 追加 `--yes`；回执解析 `openMessageId`/`deliveryStatus`；重复键映射 `unknown` 不重发 |
| 3   | 群消息整条被跳过               | 归一化只认 camelCase/atUsers                                                                       | 适配真实 snake_case；`conversationType` 按目标类型推断；`title` 回退目标名；`@ownerNick` 判定        |
| 4   | 模型 7–12 秒完成但插件等到超时 | ① `TurnTracker` 用上一轮 `current` 认领新消息；② `awaitTurnEnd` 用裸 requestId 比较带前缀的消息 id | `pending` 状态等下一个 `turn/start` 认领；新增 `deliveryId()` 统一前缀，等待用带前缀 id              |
| 5   | T4 结果回复泄漏内部信息        | worker 汇报含 `Route: fast-path` 与会话 id，模板原样发到群里                                       | worker prompt 明确“面向发起人”的禁写清单；结果模板再脱敏内部行，会话 id 只进审计/面板                |

其中第 4 项的两个缺陷都由真实顺序/真实 id 触发，旧测试的桩恰好把两者都“假掉”了；修复时先补会红的复现测试（3 条 + 4 条），再改实现。

## 4. 回归与门禁

- `pnpm check`：typecheck + **702 tests** + build（脱敏修复合并后）。
- `pnpm format:check`、`node scripts/check-pack.mjs`（15 artifacts）。
- 真机复跑：T1 两目标 valid、T3 decision/outbound `sent`、T4 `succeeded` 且产物与结果回复一致；T4 脱敏修复后未重新触发真机，结果模板由 `pipeline-task` / `executor-task` 测试覆盖。
- 验收后已停用测试群目标（`targets.rows=[]`），通道回到 `idle: no enabled targets`，避免继续自动回复。

## 5. 残留与未覆盖

- 单聊（o2o）真机链路未触发；代码路径与群共享归一化/策略，但未做真实账号验收。
- 静默时段、`review` 模式、多目标并发、限流与重启退避未做真机压测。
- 群事件不含 `staffId`，`allowedSenders` 在群场景需按 openDingtalkId 配置；已在 009 记录。
- 回复器会话包含完整工具目录（约 141k tokens），会提高单次调用成本；这是 DSH 会话的现状，不影响正确性。
- token 到期前 CLI 会自动刷新；若 refresh token 失效仍需人工 `dws auth login`。
- 测试期间的临时文件（群 id、原始事件、批准 id）仅存本地 `.whale-live`，验收后删除，不入库。

## 6. T4 结果脱敏（已修复）

T4 结果回帖曾暴露内部信息：`Route: fast-path` 与 `会话：whale-task-...`。这是对外文本不该出现的实现细节。处置已合并（`f43d7c3`）：

- WS5b：结果模板脱敏，只保留任务标题与摘要，不输出内部路由、工具名、会话 ID、工作区路径。
- WS4：收窄 worker 的汇报提示，要求只写面向发起人的任务结果，不写执行器内部结构。
- 覆盖：`tests/pipeline-task.spec.ts` 与 `tests/executor-task.spec.ts` 增加脱敏断言；`pnpm check` 702 tests 全绿。
- 发布基线：以修复后的结果模板为准；T4 真机未重新触发（避免再次打扰测试群），真机证据与模板测试共同构成发布依据。
