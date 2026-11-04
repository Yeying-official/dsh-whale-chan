# WS14 发布后真机验活报告（归档 → 下一条消息）

- 日期：2026-11-04（Asia/Shanghai）
- 分支/提交：`main` @ `c82027a`（tag `v0.4.0` 指向该提交）；本报告是 tag 之后的补验提交
- 环境：Windows 11 x64；DSH Desktop `0.2.1-rc.5`（宿主进程 10:35:47 启动，本轮未重启）；插件以 `link:` 安装指向本仓库，热重载后运行 `0.4.0`；Node v24.15.0；`dws` v1.0.66（auth 有效）
- 账号/数据：企业账号；内部 5 人测试群；本文不记录 corpId、userId、token、完整群 id/群名与真实姓名；插件状态目录记作 `<stateDir>`（`~/.dsh-whale-chan`）
- 范围：面板「归档会话」成功执行 → 归档后下一条群聊消息使用新会话并回复
- 关联：[WS14 验收报告](WS14.md)、[005 面板](../005-panel.md)、[007 架构](../007-architecture.md)、[012 发布](../012-release.md)
- 现场截图：`.artifacts/ws14-live/archive-result.png`（仅本地复核，不入库）

## 0. 结论

| 项                 | 结果   | 证据                                                                                                                                    |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 面板归档执行       | 通过   | 审计 `workspace.sessions-archived`：`archived=3`、`refused=failed=missing=0`、`replySessionRotated=true`；弹窗“已归档 3 / 原本已归档 2” |
| generation 轮换    | 通过   | KV `session.reply-generation:group:<redacted>` = `{"generation":2}`                                                                     |
| 归档集合更新       | 通过   | `archivedSessionIds` 含 g0、g1，不含 g2；工作区 `sessionIds` 首项为 g2                                                                  |
| 下一条消息换新会话 | 通过   | g2 `createdAt=13:50:06.806`，紧接第二条消息入库 `13:50:06.776`；归档前 g1 创建于 `13:43:02.591`                                         |
| 群内回复           | 通过   | `decision.classified intent=chat` → `reply.sent`（13:50:22.214）；`dws chat +chat-messages` 13:50:21 可见机器人回复                     |
| 归档不删会话目录   | 通过   | g0、g1、g2 三个会话目录均在                                                                                                             |
| 热重载加载 0.4.0   | 通过   | `GET /whale-chan/api/state` 返回 `version=0.4.0`；插件服务于 05:37:43Z 启动，DSH 宿主进程 10:35:47 启动（未重启）                       |
| 新归档路由已注册   | 通过   | 未知目标 `POST .../archive-sessions` → 404 `unknown_target`；同路径 `GET` → 405 `Allow: POST`                                           |
| 测试后目标清理     | 通过   | `GET /whale-chan/api/targets` → `{"targets":[]}`；health channel `idle: no enabled targets`                                             |
| 第一条被判 task    | 观察项 | 分类器判 `task`、生成 awaiting-approval、未产生聊天回复；13:44:46 已取消，不构成本功能缺陷                                              |

结论：**“面板归档 → 下一条聊天消息”链路在真实宿主上通过**，未发现新的 P0/P1；WS14 既有的 P1-5（审计只有计数）与 P2-6（>500 尾部）限制不变。

## 1. 复核方式与边界

- 独立、只读复核：`curl` 读取插件 `state`/`health`/`targets`；以 `node:sqlite` 只读打开 `<stateDir>/state.db`；直接读取 `~/.dsh/storages/workspace.json` 与会话头；`dws chat +chat-messages` 只读拉取群消息。
- “面板点击/弹窗”本身不可脚本化复现，本文用三类交叉证据补齐：设置历史（`settings_history`）、审计事件（`events`）、文件与目录时间（会话头 `createdAt`、目录 `CreationTime`）。
- 只覆盖一条链路；未覆盖项见 §6，不把本次结论外推为完整 T3/T4 重跑。

## 2. 加载与发布形态

| 检查             | 观察                                                                                                                                | 结论                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 仓库版本         | `package.json` = `0.4.0`                                                                                                            | 与 tag 一致            |
| profile 安装方式 | `~/.dsh/profiles/desktop/package.json` 依赖 `"dsh-whale-chan-assistant": "link:E:/DSHWork/dsh-Whale-chan-Assistant"`                | `link:` 指向本仓库     |
| 解析后的包版本   | profile `node_modules/dsh-whale-chan-assistant` 为符号链接，解析到本仓库；其 `package.json` = `0.4.0`                               | 加载的是工作副本       |
| 运行中版本       | `GET /whale-chan/api/state` → `{"version":"0.4.0","startedAt":"2026-11-04T05:37:43.540Z"}`                                          | 宿主内存中为 0.4.0     |
| 是否重启 DSH     | 宿主进程（监听 55218）`StartTime = 2026/11/4 10:35:47`，早于插件服务启动 13:37:43                                                   | 未重启；热重载生效     |
| 新路由           | `POST /whale-chan/api/targets/ws14-unknown-target/archive-sessions` → `404 {"code":"unknown_target"}`；`GET` → `405`、`allow: POST` | 0.4.0 路由已注册       |
| 健康             | health 全 `ok`；`auth` = `dws authorization is valid`；channel = `idle: no enabled targets`                                         | 插件可用、测试后已停用 |

说明：热重载通过插件管理器 disable→enable 完成；这是本次采用的操作方式，**不代表**官方安装流程可以省略重启（见 §6）。

## 3. 操作时间线

| 时间（+08） | 事件                                                                                         | 可复核证据                                                              |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 13:37:43    | 插件热重载，0.4.0 服务启动                                                                   | `state.startedAt=05:37:43.540Z`；宿主进程 10:35:47 启动                 |
| 13:41:28    | targets revision 15 生效：`kind=group`、`mentionOnly=true`、`replyMode=auto`、`enabled=true` | `settings_history` id 26，`saved_at=05:41:28.092Z`                      |
| 13:43:00    | 另一成员在测试群 @ 主人发第一条（要求回复“第一条已收到”）                                    | `messages` 第 1 条，`at=05:43:00.947Z`；`dws` 13:43:00                  |
| 13:43:02    | 插件入库并**新建 g1**（g0 已归档被跳过）                                                     | `events` seq 74；g1 会话头 `createdAt=1793770982591` = 13:43:02.591     |
| 13:43:13    | 分类为 `task`，生成 awaiting-approval，未产生聊天回复                                        | `events` seq 76/77/78；`decisions.intent=task`、`status=task_created`   |
| 13:44:46    | 通过 API 取消该任务                                                                          | `events` seq 79 `task.cancelled`；`tasks.status=cancelled`              |
| 13:47:35    | 面板「归档会话」确认执行（`stopActivity` 默认关）                                            | `events` seq 80；弹窗截图                                               |
| 13:50:04    | 同一成员发第二条聊天式消息                                                                   | `messages` 第 20 条，`at=05:50:04.450Z`；`dws` 13:50:04                 |
| 13:50:06    | 预检发现当前会话已归档，**新建 g2**                                                          | g2 会话头 `createdAt=1793771406806` = 13:50:06.806；目录创建 13:50:07   |
| 13:50:15    | 分类为 `chat`                                                                                | `events` seq 83                                                         |
| 13:50:21-22 | 起草、入队并发送回复；群内出现机器人回复                                                     | `events` seq 84/85/86；outbound `sent_at=05:50:22.214Z`；`dws` 13:50:21 |
| 13:52:32    | 清空目标                                                                                     | `settings_history` id 27、revision 16；`GET /targets` 为空              |

## 4. 关键证据

### 4.1 目标设置与通道

- 测试期间生效的 targets 为 revision 15（`settings_history` id 26，`saved_at=2026-11-04T05:41:28.092Z`），解析后只有 1 行：
  `kind=group`、`mentionOnly=true`、`replyMode=auto`、`enabled=true`（id/label 已脱敏）。
- 测试后 revision 16（`05:52:32.396Z`）为 `{"rows":[]}`；当前 `GET /whale-chan/api/targets` 返回 `{"targets":[],"supportedKinds":["at-me","group","dm"]}`。
- 当前 health 的 channel 为 `idle: no enabled targets`；操作时面板显示的 `ready; 1 target(s)` 已不可重放，但由 revision 15、审计事件中的 `targetId` 与第二条消息实际回复三者交叉证明。

### 4.2 面板归档结果

- 面板弹窗（侧栏 DSH助理 → 目标 → 工作区「归档会话」→ 确认，`stopActivity` 保持默认关）结果：
  **已归档 3、原本已归档 2、运行中未归档 0、未找到 0、失败 0**，提示“下一条钉钉消息将使用新会话。”；截图 `.artifacts/ws14-live/archive-result.png`。
- 审计事件 `workspace.sessions-archived`（`events.seq=80`，`at=2026-11-04T05:47:35.980Z`）：
  `archived=3`、`refused=0`、`failed=0`、`missing=0`、`stopActivity=false`、`replySessionRotated=true`。
- 审计只记录计数、不记录 session id 列表（WS14 P1-5 已知限制）；“原本已归档 2”与最终归档集合一致（见 4.3），但无法仅凭审计还原具体是哪 2 个。

### 4.3 generation 与归档集合

- KV：`session.reply-generation:group:<redacted>` = `{"generation":2}`（只读查询 `kv` 表）。
- `~/.dsh/storages/workspace.json` 的全局 `archivedSessionIds` 含 g0 `whale-reply-3a858abdfd8e`、g1 `whale-reply-8bd45f085846`，**不含** g2 `whale-reply-e14e4b085868`。
- 测试群工作区记录（id 与路径已脱敏）：

| 会话                          | 在 `archivedSessionIds` | 在工作区 `sessionIds` | 会话目录存在 |
| ----------------------------- | ----------------------- | --------------------- | ------------ |
| g0 `whale-reply-3a858abdfd8e` | 是                      | 否                    | 是           |
| g1 `whale-reply-8bd45f085846` | 是                      | 是                    | 是           |
| g2 `whale-reply-e14e4b085868` | 否                      | 是（首位）            | 是           |

- 工作区 `sessionIds` 现为 `["whale-reply-e14e4b085868","whale-reply-8bd45f085846","session-c5e81964-…"]`；g1 虽已归档仍出现在该数组中，是宿主 registry 的当前观测状态，本文不据此推断宿主内部清理策略。
- 三个会话目录都保留在 `~/.dsh/sessions/--…conversation-0d7a92c2f345eead--/` 下，归档未删除目录或会话日志。

### 4.4 新会话与目录

会话头（`session.v4.jsonl.zstd` 首行）中的 `createdAt`：

| 会话 | `createdAt`（epoch ms） | 本地时间（+08）     | 对应消息                                  |
| ---- | ----------------------- | ------------------- | ----------------------------------------- |
| g0   | 1793702447534           | 2026-11-03 18:40:47 | 更早的会话（测试前已归档）                |
| g1   | 1793770982591           | 2026-11-04 13:43:02 | 第一条（`message.received` 13:43:02.553） |
| g2   | 1793771406806           | 2026-11-04 13:50:06 | 第二条（`message.received` 13:50:06.776） |

- g2 目录 `CreationTime = 2026/11/4 13:50:07`，位于 `~/.dsh/sessions/--…conversation-0d7a92c2f345eead--/whale-reply-e14e4b085868`。
- g1 的创建时间与第一条消息入库只差约 38ms，说明第一条的预检已跳过已归档的 g0、落到 g1；这是本次的额外观察，不是专门设计的步骤。

### 4.5 群内回复

- `decisions`：第二条 `intent=chat`、`status=sent`、`outbound_id=outbound-9db37bee-cbd4-4f53-a472-bd7c95ed1330`。
- `outbound`：`status=sent`、`attempts=0`、`sent_at=2026-11-04T05:50:22.214Z`、receipt `msgnPyB9nMPUMyuR3WkKELonQ==`。
- `events`：seq 83 `decision.classified intent=chat` → seq 84 `reply.drafted` → seq 85 `reply.queued` → seq 86 `reply.sent`。
- `dws chat +chat-messages --group <redacted> --start "2026-11-04 13:40:00" --end "2026-11-04 13:53:00" --order asc --page-all -f json` 返回 4 条：
  13:40:30 的早于目标启用的消息、13:43:00 第一条、13:50:04 第二条、13:50:21 机器人回复。**第一条与第二条之间没有机器人回复**，与“第一条只生成任务、未聊天回复”一致。
- 回复正文为鲸鱼女仆人设的一句话自我介绍（“我是大肥鱼，蓝白配色的鲸鱼女仆……尾巴轻轻一甩，就能把事一件件办妥。”）；`dws` 的 13:50:21 与本地 `sent_at` 13:50:22.214 的差异是群端展示时间与本地发送完成时间的正常偏差。

## 5. 与设计预期的对照

| 预期                                     | 实际观察                                           | 结论 |
| ---------------------------------------- | -------------------------------------------------- | ---- |
| 归档返回分区计数，活动会话默认被拒       | `archived=3`、`refused=0`、`failed=0`、`missing=0` | 符合 |
| 当前 replier 在归档集内时轮换 generation | `replySessionRotated=true`；KV generation 1 → 2    | 符合 |
| 归档后的下一条消息使用新会话             | g2 在第二条消息入库后立即创建，并产生唯一一次回复  | 符合 |
| 不删除目录、不删会话日志                 | g0/g1/g2 目录均存在                                | 符合 |
| 已归档会话不再被投递                     | 第一条预检从已归档 g0 跳到 g1（额外观察）          | 符合 |
| `stopActivity=false` 透传                | 审计事件 `stopActivity=false`                      | 符合 |

## 6. 未覆盖与限制

1. **只覆盖“面板归档 → 下一条聊天消息”这一条链路**；不能据此宣称 WS14 全部场景已在真机通过。
2. **`stopActivity=true` 未覆盖**：本次保持默认关，活动会话被拒绝/取消的真实用户可见结果未观察。
3. **任务 worker 归档未覆盖**：第一条虽被判 task，但未批准执行，worker 会话未创建，`worker generation` 未在真机触发。
4. **DSH 手动移除工作区未覆盖**：registry 记录被手动删除后的重建/attach 仅由单测与探针覆盖。
5. **单聊（dm）未覆盖**：测试群为 group。
6. **多目标并发未覆盖**：测试期间只有 1 个启用目标。
7. **Windows symlink/路径规范化未覆盖**：真实工作区路径未经过符号链接；`realpath` 分支仍只有 fake 覆盖。
8. **第一条被分类为 task 是分类器行为**：已通过 `POST /tasks/<id>/cancel` 取消，不构成本功能缺陷；本次未调整分类器。
9. **g0 在测试前已归档**，所以本次实际轮换是 **g1→g2**；“已归档会话被跳过”只在第一条消息上顺带观察了一次。
10. **热重载方式**：disable→enable 是本次采用的方式，不表示官方安装流程可以省略重启；正式安装仍应按 012 重启后验收。
11. **tag 仍停留在 `c82027a`**：本报告与 WS14 §12 是 tag 之后的补充文档提交，不含代码、版本、依赖或 schema 变更。
12. **审计可追溯性**：`workspace.sessions-archived` 只有计数（WS14 P1-5），本次无法从审计单独还原“原本已归档 2”具体是哪两个。
13. **截图未入库**：`.artifacts/ws14-live/archive-result.png` 仅本机留存；本文以命令输出、DB 字段和文件时间作为可复核证据。

## 7. 结论

在运行中的 DSH Desktop `0.2.1-rc.5` 上，0.4.0 通过插件热重载加载；面板归档成功归档 3 个会话并把 generation 推到 2；归档后的下一条群聊消息创建了新会话 g2 并正常回复，旧会话目录保留、未被再次投递。该链路**通过**，未发现新的 P0/P1；既有 P1-5/P2-6 限制保持不变。完整 T3/T4 未在本轮重跑，发布结论仍以 [WS14](WS14.md) 的门禁、探针与本文的定向真机补验共同构成。
