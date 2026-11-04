# 002 授权与回复策略

> 当前状态：WS3 已实现回复策略（`src/brain/policy.ts`、`rate-limit.ts`、`loop-guard.ts`）；WS15 让目标行的 `mentionOnly` 真正参与判定，并按消息来源解析目标行（见 §6.1）。
> 本文说明“一条消息什么时候可以被回复、以什么方式回复”，以及为什么它**不授予**任何
> 任务执行权。任务批准见 [003 执行](003-execution.md)，发送与 AI 角标见
> [010 设计摘要](010-design.md) §2。

授权分两件事，必须分开看：

1. **回复授权**：这条消息能不能回、能不能自动发。本文第 1–6 节。
2. **任务授权**：AI 能不能替主人干活。**永远不能**，只能捕获任务并等待面板批准。第 7 节。

## 1. 三种回复模式

`gateReply` 只产出三种结果之一（`src/brain/types.ts`）：

| 模式     | 含义                             | 谁执行发送                   |
| -------- | -------------------------------- | ---------------------------- |
| `auto`   | 自动回复，直接进入 Outbox        | 发送层（固定追加 AI 角标）   |
| `review` | 只生成草稿，等主人在面板确认     | 主人点击“发送”后由发送层发出 |
| `off`    | 不生成草稿，不发送；消息仍被记录 | 无人                         |

## 2. 判定顺序（先硬后软，后者不能放宽前者）

| 序号 | 条件                                                                        | 结果     | reason               |
| ---- | --------------------------------------------------------------------------- | -------- | -------------------- |
| 1    | `monitor.enabled = false`                                                   | `off`    | `monitor_disabled`   |
| 2    | `monitor.paused = true`                                                     | `off`    | `monitor_paused`     |
| 3    | 目标不在 `targets.rows` 中                                                  | `off`    | `target_missing`     |
| 4    | 目标 `enabled = false`                                                      | `off`    | `target_disabled`    |
| 5    | 目标 `replyMode = 'off'`                                                    | `off`    | `target_off`         |
| 6    | 发送者 userId 在 `reply.blockedSenders`                                     | `off`    | `sender_blocked`     |
| 7    | `allowedSenders` 非空且发送者 userId 不在其中                               | `off`    | `sender_not_allowed` |
| 8    | 群聊、且（目标 `mentionOnly` **或** `requireMentionInGroups`）、且未 @ 助理 | `off`    | `not_addressed`      |
| 9    | `ignoreBroadcast` 且消息是广播                                              | `off`    | `broadcast`          |
| 10   | 连续 AI 回复达到 3 条                                                       | `off`    | `loop_guard`         |
| 11   | 静默时段且 `replyDuringQuiet = false`                                       | `review` | `quiet_hours`        |
| 12   | `reply.autoReply = false`                                                   | `review` | `auto_reply_off`     |
| 13   | 本会话最近 1 小时回复数 ≥ `maxPerConversationPerHour`                       | `review` | `rate_limited`       |
| 14   | 距上一条回复 < `minGapSeconds`                                              | `review` | `min_gap`            |
| 15   | 目标 `replyMode = 'review'`                                                 | `review` | `target_review`      |
| 16   | 其余                                                                        | `auto`   | `allowed`            |

顺序的理由：前 10 条是“根本不值得起草”的硬边界（起草也是浪费，还会在面板里制造噪声）；
第 11–15 条只是“现在不适合自动发”，草稿仍然有价值；第 15 条是目标的局部收紧，
它可以把 `auto` 降成 `review`，但不可能把前面任何一条 `off` 变回可发。

`reason` 是**稳定 code**，不是文案：UI 从 locale 里按 code 取句子，改文案不影响逻辑。

## 3. 静默时段

- 时间窗来自 `monitor.quietHours`（`HH:mm`，默认 22:00–08:00、启用、不回复）。
- 时间按**宿主本地时区**解释：`gateReply` 读取注入 `Date` 的 `getHours()`，所以跨午夜窗口
  命中的是这台机器上的 22 点、23 点、0–7 点，而不是消息发送方所在地的时区。
- **支持跨午夜**：`start > end` 时，命中 `hour >= start || hour < end`；`22:00–08:00`
  覆盖 22、23、0–7 点。`start == end` 视为“没有窗口”（不用关开关也能停用）。
- 边界是**左闭右开**：22:00 命中、08:00 不命中。
- `replyDuringQuiet = true` 时静默段不生效（仍然会走后面的限速与防环）。
- `quietHours.enabled = false` 时整条规则跳过。
- 静默期的结果是 `review` 而不是 `off`：夜里不该“主动回”，但一条草稿留在面板里，
  第二天主人可以直接发，比让消息自生自灭更符合“少打扰但别误事”。
- **静默期草稿不会在静默结束后自动发送**：`review` 只是决策结果，不进入发送队列；草稿只能由
  本人在面板里发送或丢弃，而且这条消息的决策不会因为时间跨过 08:00 而重算。

## 4. 限速

| 设置                              | 语义                                                 |
| --------------------------------- | ---------------------------------------------------- |
| `reply.maxPerConversationPerHour` | 同一会话最近 1 小时已发出的回复数，达上限转 `review` |
| `reply.minGapSeconds`             | 同一会话与上一条回复的最小间隔，不足转 `review`      |

计数由 `SlidingWindowCounter` 维护（`src/brain/rate-limit.ts`）：

- 窗口是 `(at - windowMs, at]`：正好一小时前的记录已经出窗。
- 每个 key 一条升序时间戳数组，读写时按窗口裁剪；按 key 独立，会话之间互不影响。
- 时间由调用方注入，`gateReply` 本身只接收已算好的 `{ hour, gapMs }`；`Infinity` 表示
  “还没发过”。
- 计数器在内存里，重启会清零：宁可忘记一次限速，也不要把错误的计数持久化成“永远不能说话”。
- 达到上限是 `review` 而不是 `off`：无限流阈值由人复核，草稿不丢。

## 5. 防回环

个人授权意味着助理用自己的账号发言，于是**自己发出的消息可能被下一次轮询当成新消息收回来**。
三层防护（`src/brain/loop-guard.ts`）：

| 函数             | 判据                                                                                                                        | 结果                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `isSelf`         | 发送者 userId 等于主人，或昵称等于主人昵称之一                                                                              | 丢弃                 |
| `isEcho`         | 与本会话最近若干条出站文本比较（去空白、NFKC、小写）；整段相等、去掉引用标记后相等、某一整行相等，或长文本（≥8 字符）被包含 | 丢弃                 |
| `consecutiveCap` | 同一会话连续 AI 回复 ≥ 3 条没有等来真人                                                                                     | `off` / `loop_guard` |

为什么需要第三层：前两层是“文本相同”，第三层兜住“被改了一个字”或“对方只是没回”的情况。
上限是硬编码常量 `LOOP_CONSECUTIVE_CAP = 3`，不放进设置：主人不需要考虑这个数字。

## 6. 目标白名单与发送者名单

- `targets.rows` 是白名单：不在其中的会话一律 `target_missing`，宁可漏答也不误答
  （`010` §2.2/§9：只允许测试群与显式配置的目标）。
- `reply.blockedSenders` 优先于允许名单。
- `reply.allowedSenders` 非空时，只有名单内的人能触发回复；空表示“不限”。
- **两张名单都只存并只比较 userId**：匹配方式是去掉首尾空白后的**全等**，大小写敏感。
  昵称不参与授权——任何人都能把昵称改成名单里某个人的名字，所以按昵称匹配等于允许冒充。
- 面板负责把“选人”解析成 userId 再保存；名字只用于展示。名单里误存的昵称不会匹配任何人
  （既不会放行，也不会拦截）。
- 群聊默认必须 @（`requireMentionInGroups`）；`at-me` 目标由通道保证 `addressed`。
- **目标行「仅 @」（`mentionOnly`）从 WS15 起真正生效**，与全局 `reply.requireMentionInGroups` 是**或**关系：`target.mentionOnly || settings.reply.requireMentionInGroups` 任一为真，群消息就必须 `addressed`，否则第 8 条判 `not_addressed`。两个开关都只能收紧、不能放宽对方——关掉全局开关不会让某个 `mentionOnly=true` 的群开始回全部消息。
- `at-me` 与 `dm` 恒视为已定向，`mentionOnly` 对它们无效：`at-me` 订阅本身就只投 @ 消息，单聊没有“群里@”的概念。面板对非 `group` 行禁用该开关并给出提示，避免留下“开关存在但不生效”的误解。
- 广播（公告、群发）默认忽略；`ignoreBroadcast = false` 时才处理。

### 6.1 目标行的解析顺序（WS15）

判定表里的“目标”不是 `thread.targetId`，而是 `policy.findTarget` 按**消息来源**选出来的那一行（`src/brain/policy.ts`）：

1. 消息来自 at-me 订阅（事件键 `user_im_message_receive_at`）→ `targets.rows` 中第一条 `kind = 'at-me'` 的行；
2. 否则若线程键是 `group:<cid>` → `kind = 'group'` 且 `id` 等于该会话 id 的行；
3. 都不命中 → 回退到 `id === thread.targetId` 的行（创建这条线程的目标）；
4. 仍没有 → `target_missing`（`off`）。

为什么需要这个顺序：同一个群可以被 `at-me` 与 `group` 同时订阅，两条事件流最终都落成同一个 `group:<cid>` 线程。只按 `thread.targetId` 取行，结果取决于“哪条流最后写了线程”，于是普通群消息可能拿到 at-me 行的策略（例如 `mentionOnly` 与回复模式），@ 消息反过来又可能拿到群行的策略——这正是 WS15 修掉的 D6。按来源分派后，**普通消息按 `group` 行、@ 消息按 `at-me` 行**，两条流各自稳定。

代价是 `at-me` 行必须存在且 `enabled`：删掉它，@ 消息会落到第 2 步的群行（或第 3 步的回退行），策略随之改变——这是可解释的行为，不是隐式兜底。

## 7. 为什么任务永远走批准

**策略只决定回复，不授予任务执行权。** 具体地：

- 分类器给出 `intent = 'task'` 只是“捕获候选”，`Engine.classify` 之后任务进入
  `awaiting-approval`，并生成一条 `pending` 的 Approval；没有批准就没有 approved/running。
- `gateReply` 的返回值只影响“是否回复、回复是否自动发”。它没有批准能力，也没有任何
  代码路径能跳过 Approval —— 面板批准是唯一入口（`010` §7）。
- 即使 `reply.autoReply = true` 且目标是 `auto`，也只会自动发送**文本**；任务执行仍需
  主人在面板点批准。自动回复的文案也由模板限制为“已记下、等主人确认”，不能声称已开始或已完成。
- 拒绝、取消、过期都是终态：批准超时后迟到的批准无效，这一点由 `src/core` 的状态机保证，
  与回复策略无关。

出现的后果：`review` 模式下的任务确认草稿同样需要人点发送；`off` 模式下消息只被记录，
主人可以在面板里看到候选任务并决定是否补一个批准流程。

## 8. 与设置的映射

| 设置                                                   | 影响的规则                           |
| ------------------------------------------------------ | ------------------------------------ |
| `monitor.enabled` / `monitor.paused`                   | 第 1、2 条                           |
| `monitor.quietHours` / `replyDuringQuiet`              | 第 11 条                             |
| `targets.rows[].enabled` / `replyMode` / `mentionOnly` | 第 3–5、8、15 条                     |
| `reply.blockedSenders` / `allowedSenders`              | 第 6、7 条                           |
| `reply.requireMentionInGroups`                         | 第 8 条（与目标 `mentionOnly` 取或） |
| `reply.ignoreBroadcast`                                | 第 9 条                              |
| `reply.autoReply`                                      | 第 12 条                             |
| `reply.maxPerConversationPerHour` / `minGapSeconds`    | 第 13、14 条                         |

数值边界来自 `src/shared/limits.ts`，字段表与默认值见 [011 设置合约](011-settings-contract.md)。

## 9. 可解释与审计

- 每条消息的 Decision 记录 `intent`、`confidence`、`reason` 与状态；回复策略的 `reason`
  是枚举 code，因此面板可以显示“为什么没回/为什么进复核”而不必读日志。
- 触发限速、防环、静默的记录不会写入消息正文（`010` §8 日志脱敏）。
- 回复被拒（`timeout`/`empty`/`echoes_system_prompt`/`model_error`）与分类失败
  （`invalid`/`timeout`/`low_confidence`）都走 defer，不会因为模型抖动而发错东西。

## 10. 不在本文范围内的授权

- **通道侧过滤**（机器人、系统通知、非人类账号）由 `src/channel` 负责；`isSelf` 只是
  第二道保险。
- **AI 角标**由发送层固定追加，模型输出无法移除或伪造。
- **任务权限预设、工作区、并发上限**属于执行授权，见 [003 执行](003-execution.md)。
- **凭证、密钥、日志脱敏**见 [013 安全](013-security.md)。

## 相关文档

- [010 设计摘要](010-design.md)
- [003 执行](003-execution.md)
- [004 提示词](004-prompts.md)
- [011 设置合约](011-settings-contract.md)
- [013 安全](013-security.md)
