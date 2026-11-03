# 006 部署

> 当前状态：WS0 冻结 `cordis.patch.yml` 的宿主机行；WS2 补充本机 `dws` 个人授权的检查、登录、验证与停止说明；WS4 增加两套 agent preset、插件工作区与会话创建排障。完整的 bundle 安装、升级、卸载与 profile 隔离留给 WS7，本文不指导修改 `~/.dsh`。

## 1. 前置条件

- 本机安装 `dws`（个人授权 CLI）。通道按 **v1.0.66 的 help 契约**实现；其它版本先按第 2 节核对事件键与参数。
- 个人授权已完成（`dws auth login`），且授权账号就是希望鲸鱼酱代为读取/发言的本人账号。
- 插件运行在 DSH 宿主进程中，`dws` 必须在宿主继承的 `PATH` 里，或在设置 `dws.binaryPath` 中写成可执行文件的绝对路径。

## 2. 版本与登录检查

```bash
dws --version
dws auth status --format json
```

`auth status` 只需看布尔与时间字段：

| 字段                         | 含义                                     |
| ---------------------------- | ---------------------------------------- |
| `authenticated`              | 是否已登录                               |
| `token_valid` / `tokenValid` | 访问令牌当前是否有效                     |
| `refresh_token_valid`        | 是否还能用 refresh token 续期            |
| `expires_at` / `expiresAt`   | 令牌过期时间（epoch 秒/毫秒或 ISO 时间） |

**不要把 `auth status` 的原始输出贴进 issue 或日志**：其中可能包含账号标识。插件的 `probeAuth` 只保留版本、三个布尔与过期时间，并丢弃其余字段。

重新登录：

```bash
dws auth login
```

常见故障：

| 现象                                        | 处理                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `dws: command not found`                    | 确认 `PATH`，或把 `dws.binaryPath` 设为绝对路径                  |
| `auth status` 退出非 0                      | 先手动执行看错误；插件会降级为 `available:false`，不重试、不猜测 |
| `authenticated:true` 但 `token_valid:false` | 执行 `dws auth login` 续期                                       |
| `event consume` 立即退出                    | 按第 3 节用 `--dry-run` 复现，检查事件键、目标 ID 与登录态       |

插件的健康检查（`GET health`，WS5 接线）会报告 `available` / `version` / `authenticated` / `tokenValid` / `expiresAt`，不包含 token 或账号 id。

### 2.1 owner 身份

插件启动订阅前必须知道“本人”的账号 id：宿主调用 `probeAuth()`，把返回的 `userId` 作为 `ownerUserId` 注入通道。没有该值时 `start` 抛 `owner-unknown` 并拒绝订阅——通道不会用群目标 id 回退猜测，否则助手可能把自己的回复当成新消息形成回环。该 id 只用于过滤自己发出的消息，不写日志、不持久化。排障时先确认 `dws auth status --format json` 能返回账号 id 字段（`user_id`/`userId`/`staff_id` 等别名，真机字段名待 T1 确认）。

## 3. 目标发现与 `--dry-run` 验证

按名称找群：

```bash
dws chat +chat-search --query "AI工程师孵化中心" --limit 20 --format json
```

从返回的 `chats[].openConversationId` 取**显式 ID**，写进设置的群目标。名称只用于搜索，订阅与发送都只接受 ID。

单聊候选（**响应结构 provisional，需真机确认**）：

```bash
dws chat +chat-list --types p2p --page-size 50 --format json
```

不创建订阅地验证一个目标：

```bash
# 群
dws event consume user_im_message_receive_group --flatten -f ndjson --ttl 24 \
  --group <openConversationId> --dry-run

# 单聊（userId）
dws event consume user_im_message_receive_o2o --flatten -f ndjson --ttl 24 \
  --user <userId> --dry-run

# 单聊（只有 openDingTalkId 时）
dws event consume user_im_message_receive_o2o --flatten -f ndjson --ttl 24 \
  --open-dingtalk-id <openDingTalkId> --dry-run
```

`--dry-run` 只打印计划并退出 0，不创建订阅、不等待事件。插件的 `validateTarget` 走同一条命令；退出非 0、超时或出现 `not logged in`/`未登录` 时返回 `{valid:false, error}`，面板只显示脱敏后的错误摘要。

## 4. 启停与订阅清理

插件（WS2 supervisor）停止一个订阅的顺序：

1. 关闭子进程 stdin；
2. 等待宽限期（默认 5 s）；
3. 仍未退出 → `SIGTERM`；
4. 再等待 3 s；
5. 仍未退出 → 标记 `orphaned`，并 best-effort 执行 `dws event stop <subscribe_id> --yes`。

**任何路径都不会 `kill -9`。** Windows 上 Node 的 `SIGTERM` 等价于强制结束进程、无法被 `dws` 捕获，所以第 1 步才是 Windows 的主要优雅停止路径；真机 T1 必须确认关闭 stdin 后订阅自行退出。

排障命令：

```bash
dws event status                 # 查看当前仍在运行的订阅
dws event stop <subscribe_id> --yes   # 手动清理遗留订阅
```

`subscribe_id` 来自就绪行：

```text
[event] ready event_key=<key> bus_pid=<n> subscribe_id=<id>
```

面板的健康视图会显示每个目标的 `starting|ready|stopped|failed|orphaned`、`subscribe_id`、重启次数与最近错误（已脱敏）。

## 5. 两套 agent preset、工作区与权限

bundle 在 `cordis.patch.yml` 里声明两个 `@deepseek-ai/dsh-agent-preset` 行，除此之外什么也不注册。它们由执行器按 id 选择，**不出现在手动选择器里**：preset 行没有「隐藏」开关，所以两行的 `description` 都写明「不供手动选择」，顺序（`order` 90/91）只决定名单内的排列。

| preset id                | 谁创建                        | 用途                                 | 工具集                                                                                                                     |
| ------------------------ | ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `dsh-whale-chan-replier` | `SessionModel`（回复路径）    | 钉钉对话回复；完整指示随用户消息投递 | persona、agent-instructions、time-context、tool-web（`fetch:false`）、compaction                                           |
| `dsh-whale-chan-worker`  | `DshTaskExecutor`（任务路径） | 执行一项已批准任务                   | 上表 + shell（bash/pwsh 按平台二选一）、tool-fs、tool-fs-search、tool-jobs（5 s）、skill-filesystem、tool-skill、tool-todo |

- **回复器没有 shell、文件、作业、skill 与 todo**。提示词注入最多让模型写一段文字，无法让它执行命令或改文件。
- **执行器前台命令最多等 5 秒**，之后由 shell 工具转入后台作业；`job_output` 的等待同样 5 秒。这样一条慢命令不会长期占住一次回合。
- 两套 preset 都不含 `tool-web` 的 `fetch`，也不含子智能体、计划模式、插件管理、定时与目标：任务要么在工作区内完成，要么汇报需要人介入。

### 5.1 目录

| 路径                               | 内容                                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| `~/.dsh-whale-chan/state.db`       | 领域状态、审计事件、effect 队列                            |
| 批准人选择的目录                   | 任务工作区（`Assignment.workspace`，**优先**）             |
| `~/.dsh-whale-chan/tasks/<taskId>` | 没有选择目录时的回退（`tasks.workspaceRoot` 可覆盖根目录） |
| `~/.dsh-whale-chan/workspace`      | 回复器会话共用工作区（不写业务文件）                       |

- **工作区以批准为准**：批准任务时主人选的目录就是 worker 的目录；设置里的 `tasks.workspaceRoot` 只是「批准时没选目录」的默认值。相对路径会被拒绝（领域错误 `invalidWorkspace`，属用户可纠正的 `refused` 组），因为 DSH 会按宿主工作目录解析它，主人无法预测文件落在哪里。
- 工作区目录在会话创建**之前**用 `mkdir -p` 建好：DSH 的 `workspaceRegistry.create` 只接受已存在的目录，不存在的路径会被拒绝。
- 回退路径里的 `taskId` 必须是单一安全路径段；含 `/`、`\` 或 `..` 的 id 会被执行器拒绝，不会写到根目录之外。
- 任务会话 id 是 `whale-task-<taskId>-<派工后缀>`（同一任务的每次派工都是一个新会话），回复器会话 id 是 `whale-reply-<sha1(threadKey) 前 12>`；这两类会话会出现在 DSH 的会话列表里，标题分别是 `任务 · <标题>` 与 `钉钉 · <会话标题>`。
- 模型来自设置：worker 用 `models.worker`，回复器用 `models.reply`；两者都为空时用部署默认模型，且**不会**修改 DSH 的全局默认模型。

### 5.2 权限

- worker 会话的权限预设取 `tasks.permissionPreset`（默认 `workspace-write`）。只有 `danger-full-access` 会被原样使用，其它值一律按 `workspace-write` 处理——设置写坏了也不会把执行器放宽。
- 回复器会话固定 `workspace-write`。
- 执行器通过 `ctx.permissionPresets.set(session, name)` 在会话创建后立即设置；权限预设名写错会在这个调用上抛错，而不是在模型调用时才失败。

### 5.3 会话创建失败怎么排查

先看插件日志里的 `dsh-whale-chan:` 前缀，再按下面的顺序定位：

| 现象                                                        | 可能原因                                                 | 处理                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 日志出现 `agent-preset/not-found` 或 `agent-preset/invalid` | preset 行没随 bundle 生效，或 `id` 拼错                  | `plugin_manager` `list_plugins` 里确认 `dsh-whale-chan-*-preset` 行的 `fiberPhase` 是 `active`；比较 `config.id` 与代码里的常量 |
| `workspaceRegistry.create` 抛「不存在/不是目录」            | `tasks.workspaceRoot` 写成了文件、盘符不存在，或权限不足 | 手动确认该路径存在且可写；留空 `workspaceRoot` 用默认目录                                                                       |
| 会话建好但没有回合结束，任务最终 `timeout`                  | worker 卡在一条前台命令，或模型侧长时间无响应            | 在 DSH 里打开该会话看最后一步；任务超时会在 `tasks.timeoutMinutes` 后取消回合                                                   |
| 结果 `failed: aborted by hook`                              | 有人在 DSH 里停止了这个回合（不是本插件的取消）          | 这是外部操作，按 `failed` 上报；重新派工即可                                                                                    |
| 结果 `cancelled`                                            | 主人在面板取消，或插件在停机时清理运行中的任务           | 正常路径；`error` 里带取消原因                                                                                                  |
| `permissionPresets.set` 抛「unknown preset」                | 部署的 preset 名单里没有 `workspace-write`               | 检查 DSH 的权限 preset 配置；本插件只使用这两个名字                                                                             |

`SessionModel` 侧的失败对回复路径表现为「模型错误」，不是任务失败：它会抛 `ModelTimeoutError` / `ModelFailedError` / `ModelAbortedError`，由调用方决定降级为「不回复」还是「回复但说明」。

### 5.4 真机会话冒烟（WS8 执行）

单元测试用 fake host 覆盖执行器逻辑，`DshSessionHost` 的真实行为需要一次真机冒烟。它**不发模型请求**，因此不消耗模型配额，只消耗宿主的会话与文件资源：

1. 在面板批准一个测试任务（标题与说明写清「冒烟，不要改文件」），确认工作区目录已创建。
2. 在 DSH 会话列表里确认出现 `whale-task-<taskId>-<后缀>`，标题为 `任务 · <标题>`；打开它检查系统提示里有主人的人设段落与安全规则。
3. 观察任务消息是否只出现一次；不要让它跑到模型调用（若已开始，直接执行第 4 步）。
4. 在面板取消该任务。预期：任务进入 `cancelled`，执行器调用 `agent.cancel(..., { keepInbox: false })`，会话的当前回合作废，队列被清空。
5. 在 DSH 日志里确认取消后该会话没有新的 `turn/end`（除取消自身产生的那一次），也没有第二条 `user/message`。

会消耗模型配额的变体（可选）：批准一个「只读一次工作区并列目录」的小任务，让它跑完一个回合，确认 `assignmentEnded` 收到 `succeeded` 且 `result.summary` 是 worker 自己的话。

## 6. 退出码与进程状态

插件把一次 `dws` 调用分为三类结果，部署排障时按此判断：

| 退出码/状态           | 插件语义                                                  |
| --------------------- | --------------------------------------------------------- |
| `0` + 明确回执        | 成功；`send` 记 `sent`，订阅进入 `ready`                  |
| `0` + 无回执          | `unknown`：结果不可证明，**禁止重发**                     |
| 非 0 + 明确目标不存在 | `gone`：目标失效，停止向该目标发送                        |
| 非 0 + 明确拒绝       | `failed`：记录错误，不自动重试                            |
| 非 0 + 无法分类       | `unknown`：**禁止重发**，等待对账                         |
| 超时 / 无输出         | `unknown`；订阅会按退避重启                               |
| 可执行文件无法启动    | `failed` / `available:false`：检查 `binaryPath` 与 `PATH` |

订阅进程意外退出按 1 s → 2 s → 4 s … 退避重启，上限 `dws.restartBackoffMaxSeconds`（默认 60 s）。目标 ID 非法属于配置错误，直接 `failed` 且不重启。

演练模式（`advanced.dryRun`）下发送返回 `skipped`：不 spawn、不改变 Outbound 状态，也不是失败；不要按失败重试。

## 7. 日志与隐私

- 默认日志不包含消息正文、token、clientSecret、账号 id 或完整原始 payload。
- `dws.debug` 或 `advanced.debugPayloads` 打开后，也只输出字段名与白名单结构字段的截断值（见 [009 DWS 协议](009-dws-protocol.md) §4.4）。
- 审计与状态目录、备份策略、profile 隔离随 WS5/WS7 落地；本工作流不写 `~/.dsh`。

## 8. 已知限制与尚未覆盖

已知限制（WS4 实现方式决定，不是缺陷）：

- **没有关闭会话的公开 API**：DSH 的 `ctx.agents` 只有 `get/list/roots/create/resume/register`，没有销毁入口。回复器「重建」因此是：取消旧会话当前回合 → 不再引用它 → 用同一身份再 `create`，由 DSH 另发一个 sessionId（执行器采纳返回值）。旧会话作为历史留在 DSH 里，不会消失。
- 任务重试是**新会话**（会话 id 带派工后缀），上一次的结论只通过任务消息里的「上一轮结果（供参考）」传给 worker。
- 模型路由只在会话首次创建时写入；之后主人在面板里改的模型优先，插件不会覆盖。
- 执行器没有全局并发上限，`tasks.maxConcurrent` 由 WS5 的调度层执行。

尚未覆盖（WS7）：

- bundle 安装/升级/卸载与 profile 隔离；
- 状态目录、日志轮转、审计保留策略；
- 版本兼容矩阵与 CHANGELOG。

## 相关文档

- [009 DWS 协议](009-dws-protocol.md)
- [010 设计摘要](010-design.md)
- [012 发布](012-release.md)
