# WS15 · 目标订阅、订阅健康与单聊修复

- 分支：`fix/ws15-target-subscriptions`（worktree `wt-ws15`）
- 基线：`main` `7a0b4df`（v0.4.0 发布后的坐标修正提交）
- 提交：`1ecea26`（单聊出站保留 open id）、`320fbe8`（联系人发现）、`488cf0a`（目标行策略）、`a80f6b3`（服务端拒绝可观测）、`a0ec771`（`GET channel`）、`aebc663`（订阅列与按类型提示）、`f97340e` / `fd8affb`（两个 `--no-ff` 合并）
- 状态：实现与自动化验收完成；**未合并、未打 tag**（实现/文档代理不执行 merge/tag/push）；**订阅/收发链路未真机验收**
- 关联：[001 领域模型](../001-domain.md)、[002 授权与回复策略](../002-authorization.md)、[005 面板](../005-panel.md)、[007 架构](../007-architecture.md)、[009 DWS 协议](../009-dws-protocol.md)、[011 设置合约](../011-settings-contract.md)、[012 发布](../012-release.md)、[兼容矩阵](../compatibility.md)、[WS15 验收报告](../test-reports/WS15.md)

## 1. 缺陷清单

这轮修复来自一次真机排查：单聊目标加进去后订阅起不来，日志里只有“进程退出 + 退避重启”，面板上看不到任何原因。逐个拆开后是 6 个独立缺陷（D5/D6 同一处代码，合并叙述为 5 条修复）。

| 编号 | 现象                                                                                           | 根因                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 单聊目标订阅必被服务端拒绝：`SYSTEM_ERROR: subscribeUser failed: registerToEventCenter failed` | `dws chat +chat-list --types p2p` **只返回 `openConversationId`**（会话 ID），没有 `userId`/`openDingtalkId`；旧实现把这个会话 ID 当 open id 交给 `--open-dingtalk-id` |
| D2   | 即使订阅成功，单聊回复也发不出去                                                               | 单聊事件只带 `sender_open_dingtalk_id`；旧 `threadTarget` 把裸 open id 当 `userId` 放进 `--user`，`dws` 解析不到人                                                     |
| D3   | 订阅失败时 `lastError` 为空，只有退出码与“重启中”                                              | `dws` 把拒绝写在 **stdout 的一行 JSON**（`{"error":{…}}`）里；旧解码把它当事件，记成 `malformed`，真正的 `message` 被丢掉                                              |
| D4   | `validateTarget` 报通过，但保存后订阅被拒                                                      | `--dry-run` 只证明参数被 `dws` 解析，不证明服务端能注册；错误的 dm id 在本地没有被拦下                                                                                 |
| D5   | 群目标「仅 @」开关不生效                                                                       | `targets.rows[].mentionOnly` 存了但策略层从未读取，群消息只受全局 `reply.requireMentionInGroups` 约束                                                                  |
| D6   | `at-me` 与 `group` 同时订阅同一群时，普通消息与 @ 消息互相套错策略                             | `gateReply` 按 `thread.targetId` 取目标行，而 `targetId` 只是“最后写这条线程的目标”，两条流会互相覆盖                                                                  |

## 2. 修复设计

### 2.1 D1：单聊按“人”发现（`src/channel/discover.ts`）

- 单聊发现改走 `dws contact user search --query <姓名> --format json`——目前唯一被实测返回**人**的标识的命令。
- 候选优先 `userId`（`--user`）；只有 `openDingTalkId` 时生成 `open:<openDingTalkId>`（`--open-dingtalk-id`）；两者都有时把 open id 放进候选 `description` 供人工核对。
- `+chat-list --types p2p` **不再作为单聊来源**：它只有会话 ID，而会话 ID 指向聊天而不是人。
- `TargetCandidate.source` 记录来源（`chat-search` / `contact-search`），面板据此展示，不需要猜。

### 2.2 D2：单聊出站保留 `open:`（`src/app/thread-state.ts`、`src/app/effects-chat.ts`）

- `threadTarget`：单聊且已知 open id 时输出 `peerUserId: 'open:<openDingTalkId>'`；只有 userId 时输出裸 id。注释写明理由：裸 open id 会被当成 `--user` 发出去并失败。
- `threadKeyOf`：发送前**去掉** `open:` 前缀，让 `thread` 键、限流计数与防环状态仍落在同一个 `dm:<peer>` 上；否则同一个人会出现两个线程。
- `recentOutboundTexts` 的 SQL 同时匹配三种写法：`userId`、裸 open id、`open:<openId>`（`peerColumns` 固定三个占位符，重复值只收窄 `IN` 列表）。升级前写下的裸 open id 出站记录仍然算数，不会把自己的旧回复当成对方的新消息。

### 2.3 D3：服务端拒绝可观测（`src/channel/supervisor.ts`）

- `#handleLine` 先判 `parsed.error` 是否为对象：是则走 `#handleServerError`，**不**进事件解码，也不计入 `malformed`。
- 记原因：`message` → `cause` → `reason` 第一个字符串，`redact` + 压单行 + 截断 240 字符，写进该目标的 `lastError` 与 `serverReason`。
- 退避：`min(dws.restartBackoffMaxSeconds, max(指数退避, retry_after_seconds × 1000))`；`retry_after_seconds` 只接受正数字。
- 停止重启：连续 3 次服务端拒绝、且**本次拒绝没有给出** `retry_after_seconds` → `state=failed`，不再安排重启；原因留在 `lastError`，修好配置后保存目标或重启插件即可重试。重试提示是 attempt 级的（每次重启清空），判据是“累计 3 次 + 本次无提示”，不是“历史上从未收到过”。
- 退出原因合并：`#fail` 优先用 `serverReason` 覆盖退出码描述，避免“拒绝 + 退出”两条噪音互相覆盖。

### 2.4 D4：dm id 在本地拒绝（`src/channel/targets.ts`）

- `CONVERSATION_ID = /^cid[^:]*=*$/i`；`parsePeerAddress` 对裸 id 与 `open:` 后的 id 都做检查，命中即抛 `ChannelError('invalid-target', …)`，消息明确要求改填 `userId` 或 `open:<openDingtalkId>`。
- `consumeSpec` 调 `parsePeerAddress`，因此订阅、`validateTarget`（`--dry-run`）与发送三条路径共用同一规则；`validateTarget` 在构造参数阶段就返回 `{valid:false, error}`，不会发出一个注定失败的 dry-run。

### 2.5 D5/D6：目标行按来源分派（`src/brain/policy.ts`）

- `findTarget` 的解析顺序：at-me 消息 → 第一条 `kind='at-me'` 行；否则线程键 `group:<cid>` → `kind='group'` 且 `id` 等于该会话的行；都不命中 → `id === thread.targetId` 的行；仍没有 → `target_missing`。
- 判定：`requiresMention = message.conversationType === 'group' && (target.mentionOnly || settings.reply.requireMentionInGroups)`，`requiresMention && !addressed` → `not_addressed`。是**或**关系：目标行只能收紧，全局开关不能放宽它。
- `at-me` 与 `dm` 恒视为已定向，`mentionOnly` 对它们无效；面板对非 `group` 行禁用开关并给出说明。

### 2.6 订阅健康（`GET channel`，`src/app/views.ts` + `src/shared/api.ts`）

- 新增第 21 条路由 `GET channel`，响应 `ChannelHealthView`：`state`（`stopped`/`starting`/`ready`/`degraded`）、`running`（由 `state !== 'stopped'` 派生）、`targets[]`（`targetId`、`kind`、`label?`、`state`、`restarts`、`readyAt?`、`lastError?`）。
- 只读投影：不读写设置、不触发重启、不清空 `lastError`；运行时未就绪返 `503 state_unavailable`。
- 面板目标表新增只读「订阅」列，按 `targetId` 匹配；`GET channel` 失败时只显示「订阅状态不可用」，编辑/保存/发现/校验/归档完全不受影响。

## 3. 契约变更

| 项                  | 变更                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 管理 API            | 20 → **21 条**，新增 `GET channel`（只读）；`tests/contract.spec.ts` 与 `docs/011` 同步                                                                  |
| `ChannelHealthView` | 新增共享类型（`src/shared/models.ts`）+ `API_ROUTES` 条目；`ChannelTargetHealthView.state` 五态 + `unknown` 仅面板兜底                                   |
| 设置                | **不变**：schema 仍 2，9 个 block / 57 个字段；`mentionOnly` 语义生效但字段未变；dm id 规则是通道校验，不是 schema                                       |
| 行为                | `mentionOnly` 从“存了不用”变为“目标行或全局任一为真”；dm 目标拒绝 `cid…=`；订阅失败连续 3 次停止重启                                                     |
| i18n                | 中英各 +17 个顶层 key（`targets.health.*` 9、`targets.discover.queryPlaceholderDm` 1、`settings.rows.{idPlaceholder,idHint,mentionOnly}.*` 7），总数 524 |

## 4. 审核返工记录

### W1 · 本地过滤误杀联系人 → 移除本地过滤

初版在 `contact user search` 之后按“名称/ID 子串”在本地再过滤一遍，理由是想让结果更贴近用户输入。评审指出：`dws` 是按**联系人姓名**搜索的，返回项里的 `nick` 可能与 `name` 不同；本地按显示名过滤会把合法候选全部删掉，用户看到“搜不到人”。

处理：`discoverPeers` 把 `finalize(...)` 的 `query` 参数去掉，本地只做 `kind:id` 去重与 50 条上限；搜索范围完全交给 `dws`。`discoverGroups` 仍保留本地过滤——群名的搜索字段与展示字段一致，过滤是收敛噪声而不是误杀。

### W2 · `findTarget` 回归：at-me 行策略串到普通消息 → 改为按来源分派

初版为了修 D5，把目标行改成“先找 at-me 行，再找 `thread.targetId`”。评审的回归用例（at-me + group 同订一群）显示：普通群消息也会先命中 at-me 行，于是套用 at-me 行的 `mentionOnly`/`replyMode`；反过来 @ 消息在某些时序下拿到群行的策略。

处理：改为**按来源分派**——at-me 消息才取 at-me 行；非 at-me 的群消息一律先按 `group:<cid>` 找会话行；只有找不到时才回退到创建该线程的行。`tests/brain-policy.spec.ts` 新增了同群双订阅的分派用例，把“普通消息按群行、@ 消息按 at-me 行”钉住。

### W3 · 缺跨重启/升级的防环用例 → 补 `thread-state.spec.ts`

`threadTarget` 改成 `open:<id>` 之后，评审追问：升级前写进 `outbound` 的裸 open id 记录还能不能被防环 SQL 匹配？如果只按新写法查，升级后的第一次回复就会把自己的旧回复当成别人说的话，触发防环。

处理：新增 `tests/thread-state.spec.ts`（7 条），在同一个数据库里分别按 `userId`、裸 open id、`open:<openId>` 三种历史写法写入出站记录，断言 `recentOutboundTexts` 三种都能命中、`threadKeyOf` 去前缀后仍得到同一个 `dm:<peer>`，并且连续回复计数不会因为写法不同而断裂。

## 5. 测试证据

全部来自本分支的真实运行（`pnpm test`）：

| 证据                            | 结果                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 全量                            | **880 tests / 63 files** 全通过（基线 v0.4.0：849 / 62；新增 31 条、1 个文件）                              |
| `channel-supervisor.spec.ts`    | 12 条：结构化 `error` 不计 malformed、`retry_after_seconds` 取大与封顶、连续 3 次无提示停止重启、退避不重叠 |
| `channel-targets.spec.ts`       | 14 条：`cid…=`/`open:cid…=` 判 `invalid-target`、`open:<id>` 走 `--open-dingtalk-id`、裸 id 走 `--user`     |
| `channel-discover-auth.spec.ts` | 21 条：`contact user search` 的参数与候选（优先 `userId`、否则 `open:<id>`）、空查询拒绝、p2p 列表不再参与  |
| `brain-policy.spec.ts`          | 27 条：目标行 OR 全局、at-me/dm 恒已定向、同群双订阅按来源分派                                              |
| `thread-state.spec.ts`          | 7 条：单聊出站保留 `open:`、`threadKeyOf` 去前缀、防环 SQL 三种历史写法                                     |
| `client-targets.spec.tsx`       | 25 条：订阅徽标/`restarts`/`lastError`、`GET channel` 失败仍可编辑/保存/校验、非 `group` 行开关禁用         |
| `api-routes.spec.ts`            | 32 条：`GET channel` 200/503、21 条路由、归档与错误码                                                       |
| `contract.spec.ts`              | 13 条：21 条路由唯一、版本三处一致、设置字段仍 57 / 9                                                       |

**没有真机证据**：本轮没有在真实钉钉账号上跑过订阅与收发。`at-me` 订阅在修复前的排查中以 `--ephemeral` 临时探测到 ready（随后撤销），这只说明事件键可用，不说明本版修复通过。`+chat-list --types p2p` 不含人员 id、o2o 事件只带 `sender_open_dingtalk_id` 两点来自同一次排查的实测记录。

## 6. 风险

- **单聊链路是最大未知**：发现、订阅、出站三段都改了，但没有一段在真实账号上验证；`o2o` 事件键能否 ready、`--open-dingtalk-id` 的发送行为都只有夹具证据。
- **`contact user search` 的形状**只实测过一种；同名/重名、分页、`nick`≠`name` 的表现未知，候选仍需人工确认。
- **`cid…=` 是形状判断**：正则是本地约定，不是服务端契约；服务端若新增 id 形态，本地可能放过一个注定失败的 id。
- **行为变更会改变现有群目标的回复量**：`mentionOnly` 生效后，某些群从“回全部”变成“只回 @”。这是回归修复的预期结果，但对主人是可见变化，已写入 Migration。
- **停止重启可能掩盖瞬时故障**：连续 3 次拒绝且无 `retry_after_seconds` 就停下，若服务端恰好在抖动，需要人工重试；换来的是真实原因不被退出噪音覆盖。
- **`GET channel` 只反映进程内状态**：`orphaned` 不会被清理，重启后 `lastError` 清零。

## 7. 合并坐标

- 分支：`fix/ws15-target-subscriptions`，基于 `main` `7a0b4df`。
- 本 PR 的提交：`1ecea26`、`320fbe8`、`488cf0a`、`a80f6b3`、`a0ec771`、`aebc663`（外加两个 `--no-ff` 合并提交）；文档与版本提交为 `chore(release): v0.5.0` 与 `docs: record ws15 target subscription fixes`。
- **未执行**：merge 到 `main`、`git tag v0.5.0`、push、profile 安装。以上由发布负责人复核后执行，见 [012 发布](../012-release.md) §7。

## 8. 相关文档

- [WS15 验收报告](../test-reports/WS15.md)
- [009 DWS 协议](../009-dws-protocol.md)
- [002 授权与回复策略](../002-authorization.md)
- [005 面板](../005-panel.md)
- [011 设置合约](../011-settings-contract.md)
