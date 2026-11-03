# 009 DWS 协议（个人授权通道）

> 当前状态：WS2 实现完成。本文描述 `src/channel` 如何调用本机 `dws`（v1.0.66 help 实测契约 + 实现），并逐项标注证据等级。
>
> 证据标记：
>
> - **[F]** 已由 `tests/fixtures/fake-dws.mjs` 夹具覆盖，可在本仓库复跑；
> - **[H]** 来自 `dws` v1.0.66 help / 既有实测记录，本工作流**未重新对真机执行**；
> - **[T1]/[T2]** 需要真机按 T0–T3 逐级验证（T1 只收不发，T2 面板确认后发送）；
> - **[P]** provisional：实现按防御性解析编写，字段名或语义尚待真机确认。

## 1. 通道边界

`src/channel` 是**唯一**允许启动 `dws` 子进程的层。它不做领域决策、不写 Store、不 import `@deepseek-ai/*`；app 通过 `DingTalkChannel` facade 注入设置读取函数与 logger。

硬规则：

- 所有子进程都用参数数组启动（无 shell 字符串拼接）、`windowsHide: true`、stdout/stderr 显式 UTF-8 解码。
- 默认日志不含消息正文、token、clientSecret、账号 id、完整原始 payload。
- 不主动发起任何真实订阅或发送；测试只运行 fake 可执行文件。

## 2. 事件键 **[H]**

| 目标 kind | `event_key`                     | 适用场景           |
| --------- | ------------------------------- | ------------------ |
| `at-me`   | `user_im_message_receive_at`    | 群聊中 @ 本人      |
| `dm`      | `user_im_message_receive_o2o`   | 指定单聊           |
| `group`   | `user_im_message_receive_group` | 指定群（全部消息） |

事件键由 `src/channel/targets.ts` 的 `EVENT_KEYS` 冻结；改键属于协议变更，不是配置变更。`at-me` 是全局订阅，同一时刻只允许一个（重复行会被 `dedupeTargets` 丢弃）。

`at-me` 目标行的 `id` 只作为消息的 `targetId` 透传，不参与订阅参数；WS5 会把该行初始化为 `at-me`。

## 3. 订阅命令 **[H]**

```text
dws event consume <event_key> --flatten -f ndjson --ttl <hours>
    [--group <openConversationId>]
    [--user <userId> | --open-dingtalk-id <openDingTalkId>]
    [--profile <profile>]
```

- **目标只用显式 ID**：`group` 用 `openConversationId`；`dm` 用 `userId`；只拿到 open id 时目标 id 写成 `open:<id>`，订阅走 `--open-dingtalk-id`。名称从不在订阅路径上被解析。
- **TTL** 取 `settings.dws.eventTtlHours`（默认 24，范围 1–720），断线重连只补收有界窗口。
- **就绪行**（stderr）**[H]**：
  ```text
  [event] ready event_key=<key> bus_pid=<n> subscribe_id=<id>
  ```
  缺少 `subscribe_id` 的行不视为就绪：没有 id 就无法清理订阅。
- **`--dry-run`** 只打印计划并退出，不创建订阅。`validateTarget` 用它做非破坏校验；非零退出、超时、`not logged in`/`未登录` 之类的授权错误都判为无效。
- **`group` 目标接收群内全部消息**，`mentionOnly` 与 `addressed` 由归一化/决策层处理，订阅参数不承担该过滤。

### 3.1 Windows 命令解析

DSH 宿主进程不保证继承交互 shell 的 `PATH`。Windows 上 npm 全局安装的 `dws` 实际是 `%APPDATA%\npm\dws.cmd`；`cross-spawn` 对裸命令只按 `PATH` 找 `.exe`/`.cmd`，宿主 `PATH` 缺少 npm 全局目录时就会解析失败（现象：health `available=false`，而终端里 `dws --version` 正常）。

`src/channel/command.ts` 的 `resolveDwsCommand(command, env, platform)` 统一处理：

1. 非 `win32`、命令含 `/` 或 `\`、或已带 `.exe`/`.cmd`/`.bat`/`.ps1` 扩展名 → **原样返回**；
2. `win32` 裸命令按顺序在以下目录查找 `<command>.cmd` → `<command>.exe` → `<command>.bat` → 无扩展名原文件：
   - `PATH`（兼容 `Path` 键）的每个目录；
   - `%APPDATA%\npm`；
   - `%ProgramFiles%\nodejs`；
   - `%LOCALAPPDATA%\Programs\nodejs`（目录存在时）；
3. 命中第一个存在的文件 → 返回绝对路径，并按 command + 相关环境变量缓存；
4. 全部未命中 → 返回原命令，让 spawn 错误保持可见，而不是伪造路径。

所有实际 spawn 的入口共享这一条规则：`createRunner` → `runOnce`（`probeAuth`、`send`、`discover`、`validate`）与 `DwsProcess.start`（supervisor）都会在启动前解析，调用方不需要各自重复处理。`settings.dws.binaryPath` 可以是绝对路径；一旦配置成路径，解析直接原样返回，等于显式覆盖。通道日志会打印一次解析后的 `dws command`，health 的每个目标带 `command` 字段（仅路径，不含账号/token）。

## 4. NDJSON 归一化

一行一个 JSON 对象，允许浅层包封 `data` / `event` / `message` / `payload`（最多两层）。字段名在 dws 各版本间出现过 snake_case 与 camelCase 混用，因此按别名表解析。

### 4.1 字段别名与证据

| 归一化字段     | 接受的别名（按优先级）                                                       | 证据 |
| -------------- | ---------------------------------------------------------------------------- | ---- |
| 消息 id        | `msgId` `messageId` `msg_id` `message_id` `eventId` `event_id`               | [F]  |
| 会话 id        | `conversationId` `openConversationId` `conversation_id` `chatId` `chat_id`   | [F]  |
| 会话类型       | `conversationType` `conversation_type` `chatType`                            | [P]  |
| 发送者 userId  | `senderStaffId` `senderId` `userId` `sender_user_id` `sender_userid`         | [P]  |
| 发送者昵称     | `senderNick` `senderName` `sender_name` `nick`                               | [P]  |
| 发送者 open id | `senderOpenDingTalkId` `sender_open_dingtalk_id` `openDingTalkId`            | [P]  |
| 正文           | `text` `content` `messageText` `body` `msgContent`；支持 `text.content` 嵌套 | [F]  |
| 发送时间       | `createAt` `createTime` `timestamp` `createdAt` `msgTimestamp`               | [P]  |
| 提及列表       | `atUsers` `mentions` `atUsersList` `mentionedUsers` `at_users`               | [F]  |
| 会话标题       | `conversationTitle` `chatName` `groupName` `title` `conversation_title`      | [P]  |
| 消息类型       | `eventType` `msgtype` `msgType` `messageType` `event_type`                   | [P]  |

时间支持三种写法：epoch 秒（≤10 位）、epoch 毫秒、可解析日期字符串；无法解析时回退到本机接收时间。正文超过 20 000 字符截断（`DEFAULT_MAX_TEXT_CHARS`）。

`conversationType` 值映射 **[P]**：`direct`/`p2p`/`single`/`1`/`one-to-one` → `direct`；`group`/`2`/`chat`/`groupchat` → `group`；缺失时按目标 kind 推断（`dm` → direct，其余 group）。

### 4.2 `addressed` 判定 **[F]**

| 目标 kind | 规则                                                                             |
| --------- | -------------------------------------------------------------------------------- |
| `at-me`   | 恒为 `true`（事件键本身保证被 @）                                                |
| `dm`      | 恒为 `true`                                                                      |
| `group`   | `atUsers`/`mentions` 含本人 userId 或昵称，或正文含 `@我` / `@<本人昵称>` 时为真 |

`@所有人` 广播：当 `settings.reply.ignoreBroadcast` 为真且没有直接 @ 本人时，整条消息跳过（skip `broadcast`）；若同时直接 @ 了本人，仍按 `addressed: true` 保留。

**group 的 `mentionOnly` 属于 WS3 策略层**：通道始终如实输出 `addressed`，不会在通道层丢弃未 @ 的群消息（订阅本身接收群内全部消息）。是否回复、是否只看提及，由策略层基于 `addressed` 与 `mentionOnly` 决定。

### 4.3 跳过原因（固定顺序）**[F]**

| 顺序 | skip          | 条件                                                                  |
| ---- | ------------- | --------------------------------------------------------------------- |
| 1    | `unsupported` | 撤回/系统/群成员变化/已读/reaction 等类型，或带 `recallAt`/`isRecall` |
| 2    | `malformed`   | 非对象、缺消息 id、缺发送者、群消息缺会话 id                          |
| 3    | `self`        | 发送者就是本人                                                        |
| 4    | `broadcast`   | 纯广播且未直接 @ 本人，且 `ignoreBroadcast` 打开                      |
| 5    | `unsupported` | 正文为空但检测到图片/文件/语音/视频等媒体迹象（`detail=media-only`）  |
| 6    | `empty`       | 正文为空**且**没有任何媒体迹象                                        |

纯媒体事件在 v1 **不回复**：核心 `InboundMessage` 没有附件字段，回复一张没有说明的图片也没有意义，因此以 `unsupported` + `detail=media-only` 跳过；带文字说明的图文仍按文字处理。

`threadKey`：`dm` → `dm:<对端 userId>`；群（含 `at-me` 落在群内）→ `group:<openConversationId>`。`targetId` 取目标配置的显式 id。

### 4.4 调试摘要 **[F]**

`dws.debug` 或 `advanced.debugPayloads` 打开时，只输出：

- 顶层字段**名**（最多 40 个，不含值）；
- 白名单结构字段的值：`eventType` `msgtype` `msgType` `conversationType` `createAt` `createTime` `timestamp` `title` `conversationTitle`，每个截断 120 字符并先 `redact`。

消息正文、发送者、msgId、conversationId 永不出现在摘要里。

## 5. 发送 **[H]** + **[F]**

```text
dws chat +messages-send --as user --ai-tag --idempotency-key <key> --wait-delivery -f json
    [--chat-id <openConversationId>]
    [--user <userId> | --open-dingtalk-id <openDingTalkId>]
    --markdown <正文>
```

- `--markdown` 与 `--text` 互斥；正文始终作为一个 argv 元素传入，不做 shell 拼接。
- `--ai-tag` 由代码固定追加，模型输出无法移除。
- 群与 `at-me` 回复都用 `--chat-id <conversationId>`；单聊用 `--user`；`open:` 前缀的目标用 `--open-dingtalk-id`。
- 没有 `idempotencyKey`、正文为空、目标会话 id 为空时**不 spawn**，直接判 `failed`。

### 5.1 回执语义 **[F]**

| 情况                                                                              | 结果                               | 上层动作                       |
| --------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------ |
| 退出 0 + `success:true` / `ok:true` / `errcode:0` / 有 messageId、processQueryKey | `sent`                             | 记录回执，Outbox 置 sent       |
| 退出 0 但没有任何确认回执                                                         | `unknown`                          | **禁止重发**，等待人工/对账    |
| 退出 0 + 明确失败（`success:false`、非零 errcode）                                | `failed` 或 `gone`                 | 写审计；`gone` 标记目标失效    |
| 退出非 0 + 明确“目标不存在/不是成员/群不存在”                                     | `gone`                             | 标记目标失效，停止向该目标发送 |
| 退出非 0 + 明确拒绝（invalid/denied/forbidden/无权限…）                           | `failed`                           | 记录错误，不自动重试           |
| 退出非 0 但无法分类                                                               | `unknown`                          | **禁止重发**                   |
| 超时、无输出、spawn 失败前的信号中断                                              | `unknown`（spawn 失败为 `failed`） | 超时禁止重发                   |
| 进程无法启动（ENOENT 等）                                                         | `failed`                           | 明确未发出，允许按幂等键重试   |
| `advanced.dryRun` 打开                                                            | `skipped`                          | 不 spawn、不改变 Outbound 状态 |

**unknown 语义**：通道无法证明消息是否送达，调用方不得重发同一 `idempotencyKey`；只能落 `send_unknown` 并等待对账/人工处理。这是 Outbox 设计的硬约束。

**skipped 语义**：演练模式下通道没有尝试发送，这不是失败，也不是成功。上层不得把 Outbound 置为 `failed`/`sent`，应保持原状态（或由 WS5 单独标记演练），更不得按失败重试。

### 5.2 幂等键

`Outbound.idempotencyKey` 是唯一外部去重键：同一键最多产生一条钉钉消息。键由 app 生成并持久化（WS5），通道只透传给 `--idempotency-key`，从不自行生成或替换。

## 6. 停止、信号与订阅生命周期

`DwsProcess.stop()` 的顺序 **[F]**：

1. `stdin.end()`（文档化的优雅停止）；
2. 等待 `graceMs`（默认 5 s）；
3. 仍未退出 → `SIGTERM`；
4. 等待 `termMs`（默认 3 s）；
5. 仍未退出 → 状态 `orphaned`，并 best-effort 执行 `dws event stop <subscribe_id> --yes` 清理订阅。

**任何路径都不发送 `SIGKILL`。** 孤儿进程会留在 health 里（`orphaned` + `lastError`），由运维处理。

Supervisor 行为 **[F]**：

- 每个 target 一个进程；同一 target 不存在并发进程（有进程或重开定时器时拒绝再次 launch）。
- 意外退出按 1 s → 2 s → 4 s … 退避重启，上限 `settings.dws.restartBackoffMaxSeconds`（默认 60 s）；就绪后重置连续失败计数。
- 目标 id 非法（如 `open:` 空 id）是配置错误：状态 `failed`，**不重启**。
- 事件按到达顺序交给 sink：每个 target 一条 promise 链，慢 sink 不阻塞 stdout、也不乱序；sink 抛错被捕获并记 warn，不中断通道。
- `stop()` 清空所有重开定时器、等待每个子进程收敛、等待 sink 链排空；`stopTarget(id)` 保留该 target 在 health 中可见（`stopped` 或 `orphaned`）。

### Windows 注记 **[T1]**

Node 的 `child.kill('SIGTERM')` 在 Windows 上等价于强制终止，POSIX 信号无法送达子进程；因此第 1 步 `stdin.end()` 才是 Windows 上的主要优雅停止路径。真机 T1 必须确认：关闭 stdin 后 `dws event consume` 能自行退出并清理订阅；若不能，`orphaned` + `dws event stop` 是兜底，而不是 kill -9。

## 7. 授权探测 **[H]** + **[F]**

```text
dws --version
dws auth status --format json
```

`probeAuth` 只提取：`available`（`--version` 是否成功）、`version`、`authenticated`、`token_valid`/`tokenValid`、`expires_at`/`expiresAt`。任何超时、非零退出、非 JSON 输出都降级为 `available:false` 或布尔 false，不抛异常、不记录原始 payload、不记录 corpId/userId/token。授权失败时通道进入可观察错误态，不猜测性降级。

**owner 身份**：`probeAuth` 还返回可选的 `userId`（`auth status` 载荷里的账号 id，接受 `user_id`/`userId`/`staff_id`/`staffId`/`open_dingtalk_id`/`openDingTalkId` 别名）。它只交给宿主用于自消息过滤：**绝不写日志、绝不持久化、绝不写入文档**。宿主把它作为 `ownerUserId` 注入 `DingTalkChannel`，`start` 在“存在 enabled target 且 `ownerUserId` 为空”时抛 `ChannelError('owner-unknown')` 并拒绝订阅；通道**不再**从 at-me 行 id 回退猜测。缺失时强行启动会让助手把自己的回复当成新消息，形成回环。

## 8. 目标发现 **[H]** + **[P]**

```text
dws chat +chat-search --query <q> --limit 50 --format json
dws chat +chat-list --types p2p --page-size 50 --format json
```

- `+chat-search` 返回 `{ chats: [{ name, openConversationId, ... }] }` 已记录 **[H]**；本实现从 `chats`/`conversations`/`items`/`list`/`results`/`data` 中容错取数组，按 `openConversationId` 等字段建候选。
- `+chat-list --types p2p` 的返回结构**未实测 [P]**。实现同时接受 `userId`/`staffId`/`peerUserId` 与 `openDingTalkId`/`openConversationId`/`conversationId`/`chatId`；有 userId 时优先用它（`--user`），只有 open id 时加 `open:` 前缀。查询在本地按名称/ID 子串过滤，因为该命令的查询参数未确认。
- 发现结果最多 50 条、按 `kind:id` 去重，只作为**待人工确认的候选**；名称永远不会被自动转换成订阅或发送目标。
- 非 JSON 输出、非零退出、超时分别抛出 `ChannelError` 的 `dws-output`、`dws-failed`、`dws-timeout`，错误信息脱敏并截断。

## 9. 未验证（provisional）清单

以下行为/字段在实现中已被夹具覆盖，但**尚未在真机确认**；T1–T2 验证时按顺序核对，任何不一致都必须先改文档与测试再改实现：

1. `user_im_message_receive_*` 三个事件键在登录态下的实际可用性（[H] 来自 help）。
2. NDJSON 原始字段名：`senderStaffId` 是否总存在、`conversationType` 的取值集合、`atUsers` 的元素结构（字符串 vs 对象）、`createAt` 的单位、会话标题字段名。
3. `+chat-list --types p2p` 的响应结构与分页语义；`+chat-search` 的 `--format json` 是否被接受。
4. `auth status --format json` 的字段名、`expires_at` 格式与账号 id 字段（`user_id`/`userId`/`staff_id` 等别名）。
5. `+messages-send` 的成功回执字段（messageId / processQueryKey / errcode）与 `--wait-delivery` 的行为。
6. Windows：`stdin.end()` 是否能优雅结束订阅；`dws event stop <id> --yes` 的实际语法与权限。
7. `--ttl` 的单位与补收窗口语义；断线后是否重复投递旧事件。
8. `--profile` 在 `event consume` / `auth status` / `send` 上的位置与可接受性。
9. `open:<id>` 前缀是本项目的显式约定（不是 dws 语法），用于区分 `--user` 与 `--open-dingtalk-id`。
10. 群目标“订阅全部消息 + 本地 mention 过滤”的权限前提（是否要求管理员授权）。

## 相关文档

- [010 设计摘要](010-design.md)
- [006 部署](006-deployment.md)：安装、登录、排障与 `--dry-run` 验证
- [013 安全](013-security.md)
- [WS2 测试报告](test-reports/WS2.md)
