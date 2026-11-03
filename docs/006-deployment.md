# 006 部署

> 当前状态：WS0 冻结 `cordis.patch.yml` 的宿主机行；WS2 补充本机 `dws` 个人授权的检查、登录、验证与停止说明。完整的 bundle 安装、升级、卸载与 profile 隔离留给 WS7，本文不指导修改 `~/.dsh`。

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

## 5. 退出码与进程状态

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

## 6. 日志与隐私

- 默认日志不包含消息正文、token、clientSecret、账号 id 或完整原始 payload。
- `dws.debug` 或 `advanced.debugPayloads` 打开后，也只输出字段名与白名单结构字段的截断值（见 [009 DWS 协议](009-dws-protocol.md) §4.4）。
- 审计与状态目录、备份策略、profile 隔离随 WS5/WS7 落地；本工作流不写 `~/.dsh`。

## 7. 尚未覆盖（WS7）

- bundle 安装/升级/卸载与 profile 隔离；
- 状态目录、日志轮转、审计保留策略；
- 版本兼容矩阵与 CHANGELOG。

## 相关文档

- [009 DWS 协议](009-dws-protocol.md)
- [010 设计摘要](010-design.md)
- [012 发布](012-release.md)
