# 兼容矩阵

> 适用范围：`dsh-whale-chan-assistant` `0.6.0`（WS0–WS16 完成；Windows 真机 T0–T4 由 v0.1.0 完成，v0.2.0 工作区做 T3/T4 复验，v0.3.0 人设默认/预设做重载核对，v0.4.0 做发布后定向真机验活（归档 → 下一条消息），**v0.5.0 的订阅/收发链路与 v0.6.0 的回复预算/重试均尚未真机验收**）。
> 最后核对：2026-11-05（Asia/Shanghai）。
>
> **权威顺序**：`package.json` 的 `dsh.compatibility` 与 WS8 的 T0–T4 记录 > 本文 > 其它说明。本文中的“已验证”只表示在本机 Windows 环境实际跑过，不表示在所有同版本环境都成立。

## 1. 结论

| 组件          | 已验证                                                                                                                                                                             | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DSH Desktop   | `0.2.1-rc.5`（Windows x64）                                                                                                                                                        | **compatible**，`dsh.compatibility` 正式声明                                                                                                                                                                                                                                                                                                                                                                                                           |
| DSH 其它版本  | 无                                                                                                                                                                                 | 未验证；不要假设向前/向后兼容                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `dws`         | `1.0.66`（`f215043e`，2026-10-28）                                                                                                                                                 | 群事件/发送回执已真机确认；**单聊链路（联系人发现、`open:` 出站、服务端拒绝）v0.5.0 已修复但未真机验收**；其它版本仍 provisional                                                                                                                                                                                                                                                                                                                       |
| Windows       | 10/11                                                                                                                                                                              | 已实测（开发机与桌面端）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 真机验收      | T0–T4（Windows 10/11、DSH `0.2.1-rc.5`、`dws` `1.0.66`）+ v0.2.0 工作区复验 + v0.3.0 人设默认/预设核对 + **v0.4.0 发布后定向验活（归档 → 下一条消息）**；v0.5.0 与 v0.6.0 均未验收 | v0.4.0 归档链路定向通过：面板归档 3 / 原本已归档 2 / 0 拒绝 / 0 失败、generation 1→2、下一条群消息新建 g2 并回复。**v0.5.0 的订阅/单聊修复与 v0.6.0 的引用预算/自动重试只有单测与假 `dws` 夹具证据**。见 [WS8](test-reports/WS8-live.md)、[WS9/WS10](test-reports/WS9-10.md)、[WS12](test-reports/WS12-persona.md)、[WS14](test-reports/WS14.md)、[WS14-live](test-reports/WS14-live.md)、[WS15](test-reports/WS15.md) 与 [WS16](test-reports/WS16.md) |
| macOS / Linux | 无                                                                                                                                                                                 | **未验证**，不作为支持承诺                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Node.js       | 24.15.0（开发）、24.21.0（DSH Desktop 自带）                                                                                                                                       | 已实测；`engines` 允许 `^22.19.0 \|\| >=24.0.0`                                                                                                                                                                                                                                                                                                                                                                                                        |
| 单实例        | 同一 `stateDir` 一个进程                                                                                                                                                           | 已实现并由测试覆盖；崩溃后锁 stale 10 秒                                                                                                                                                                                                                                                                                                                                                                                                               |
| 模型路由      | 宿主默认；或按回复器/执行器分别指定 provider + model + effort                                                                                                                      | 代码路径已测；未逐一验证所有 provider                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 2. DSH 版本

| DSH 版本          | 状态          | 说明                                                                                                           |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `0.2.1-rc.5`      | ✅ compatible | `dsh.compatibility.dshReleases["0.2.1-rc.5"] = "compatible"`；本机 desktop profile 已安装并以 `link:` 方式运行 |
| 其它 `0.2.1-rc.x` | ⚠️ 未验证     | 可能可用，但宿主 API、客户端槽位或插件清单行为可能不同；安装前先在干净 profile 跑 `pnpm check` 与 T0–T1        |
| `0.2.0` 及更早    | ❌ 不支持     | 依赖的 `@deepseek-ai/*` 包版本、客户端 inject 与权限 preset 契约不同                                           |
| `0.3.x` 及未来    | ❓ 未知       | 需要重新核对宿主 API、`dsh.compatibility` 与 state schema；不要在未验证时直接升级生产实例                      |

判断依据：

- `package.json` 的 `engines.dsh` 为 `^0.2.1-rc.5`，`dsh.compatibility` 只标记 `0.2.1-rc.5`。
- `scripts/check-pack.mjs` 会校验这两项，CI/本地打包门禁不会放行被改坏的兼容声明。
- 桌面端实际运行时为 `0.2.1-rc.5`，bundled Node `24.21.0`，host protocol 4。

升级 DSH 前：

1. 在干净 profile（非生产状态目录）安装同版本插件；
2. 跑 `pnpm check` 与 `node scripts/check-pack.mjs`；
3. 按 [012 发布](012-release.md) 的 T0–T4 重新验收；
4. 确认 `state.db` schema 没有被新宿主改写；降级时不要用新库打开旧插件。

`0.3.0` 只改人设默认值与只读预设投影，`0.4.0` 只增加会话归档与会话/工作区恢复，`0.5.0` 只修目标订阅与增加只读的订阅健康接口，`0.6.0` 只改回复后处理（正文与引用预算分离）并新增一个带默认值的设置字段，**都不改变 DSH 兼容声明**：`engines.dsh` 仍是 `^0.2.1-rc.5`，`dsh.compatibility` 仍只标记 `0.2.1-rc.5`，`state.db` schema 仍是 2。因此本节的 DSH 版本结论与 v0.2.0 相同，没有“必须升级宿主”的要求。0.4.0 依赖 DSH 已有的归档闸门与 workspace registry 行为（`archivedSessionIds`、`archiveSession`、`list`、`attachSession`），这些在 `0.2.1-rc.5` 上存在；0.5.0 只用到已有的 HTTP 路由与 `session/event` 之外的通道能力，不新增宿主依赖；0.6.0 只改 `src/brain/reply.ts` 的纯文本后处理与 `src/app/effects-chat.ts` 的一次重试，不新增宿主 API。其它 rc 版本需要重新核对后再声明。

## 3. `dws` 版本

| `dws` 版本 | 状态           | 说明                                                                                                              |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `1.0.66`   | ✅ 实测        | 事件键、`event consume` 参数、`+messages-send`、`auth status` 按该版本 help/实测实现；Windows npm shim 已实际解析 |
| 其它 1.0.x | ⚠️ provisional | 解析器对 snake_case / camelCase 做别名兼容，但字段集合、回执字段与 `--ttl` 语义未逐版验证；先跑 T1 只读观察       |
| 更早版本   | ❌ 未验证      | 事件键或 `--ai-tag`/`--idempotency-key` 可能不存在；不要降级后直接订阅                                            |

WS8 已在 Windows + `1.0.66` 上确认：群事件键与 snake_case 扁平字段（`message_id`、`conversation_id`、`sender_open_dingtalk_id`、`content`、`event_time`、`create_time`）、`@ownerNick` 文本判定、`+chat-search`、`--ttl` 需 Go duration、非交互发送需 `--yes`、`openMessageId`/`deliveryStatus` 回执，以及重复幂等键返回 `CONFLICT_ERROR` 时按 `unknown` 处理。以下内容仍 provisional，真机 T1/T2 必须逐项核对（详见 [009 DWS 协议](009-dws-protocol.md) §9）：

- 单聊（o2o）订阅与出站链路：v0.5.0 已按“事件只带 `sender_open_dingtalk_id` → 发送走 `--open-dingtalk-id`”修好，并用 `contact user search` 代替 `+chat-list --types p2p` 发现联系人；**尚未在真实账号上跑通**，`o2o` 事件键的 ready 也未实测；
- `contact user search --format json` 的字段形状只在一次排查中实测（含 `userId`/`openDingTalkId`），同名/重名与分页未验证；
- `auth status --format json` 的账号 id 字段别名与过期时间格式（T0 只用 `user_name` 做 ownerNick）；
- Windows 上关闭 stdin 能否优雅结束订阅，以及 `event stop <id> --yes` 的实际语法；
- `--profile` 在 `event consume` / `auth status` / `send` 上的位置；
- 群目标“订阅全部消息 + 本地 mention 过滤”的权限前提；
- 群事件不含 `staffId`/`atUsers`/`conversationType`/`title`；发送者白名单在群场景需按 `sender_open_dingtalk_id` 配置。

## 4. 操作系统与运行时

| 项            | 已验证               | 说明                                                                                                      |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| Windows 10/11 | ✅                   | 路径解析、npm shim、`cross-spawn`、`node:sqlite`、`proper-lockfile` 均在本机运行                          |
| macOS         | ❌ 未验证            | 代码没有 macOS 专属分支；`dws` 安装方式、信号语义与路径大小写需要重新验证；不要在 mac 上宣称已支持        |
| Linux         | ❌ 未验证            | 同上；另外 `dws` 的安装/授权与桌面端支持范围未确认                                                        |
| Node 24       | ✅ 24.15.0 / 24.21.0 | 使用内置 `node:sqlite`（`DatabaseSync`），无需原生编译；`engines` 仍允许 22.19+，但 22.x 未实测           |
| pnpm          | ✅ 11.4.0            | `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm pack:check` 通过                                    |
| 模型 provider | ⚠️ 取决于宿主        | 留空 = 宿主默认；填 `provider/model/effort` = 只注入新会话，不修改全局默认；未逐一验证每个第三方 provider |

## 5. 单实例与持久化

- 同一 `stateDir` 只允许一个插件实例；第二个实例启动直接失败（`state directory is already in use`），不会排队重试。这是有意的：两个进程同时消费同一账号的事件会重复回复。
- 锁为目录 `<stateDir>/.lock`，stale 阈值 10 秒；不要在运行时手删。
- SQLite schema v2（13 张表，WAL）。打开更高版本数据库会拒绝，不降级；备份/恢复见 [006 部署](006-deployment.md) §9.4。
- 单实例与 schema 版本均不随 DSH/`dws` 版本变化而放宽。

### 5.1 工作区布局（v0.2.0）

- **一个会话一个目录**：`<root>/conversation-<sha256(threadKey) 前 16 位>`；`<root>` 取 `tasks.workspaceRoot`（展开 `~` 后必须是绝对路径），否则 `<stateDir>/workspaces`。回复器会话与该会话派生的每个任务共用同一目录。
- **目录名稳定**：同一 `threadKey` 的摘要固定，重启、升级与改标题都不会换目录；`tasks.workspaceRoot` 改成新根只影响之后解析出的路径，旧目录原地保留。
- **布局版本只进会话 id**：`WORKSPACE_LAYOUT_VERSION`（当前 `v2`）折进回复器会话 id，升级后第一次回复新建 `whale-reply-*` 会话；`state.db` schema 仍是 2，没有额外迁移，因此 v0.1.0 与 v0.2.0 可以打开同一个库。降级到 v0.1.0 时回复器回到 `<stateDir>/workspace`，`workspaces/` 与其中的文件保留但不再被使用。
- **DSH registry 幂等**：目录先 `mkdir -p` 再 `workspaceRegistry.create(path, title)`；已按同一 path 注册时只更新标题，不新建第二条记录。目录被手动删除后，下一次预建会重建目录并重新注册。
- **不随目标删除而回收**：停用/删除目标不会删除目录或注册记录，因为同一会话可能经其它目标到达，历史属于主人。

### 5.2 人设默认与预设（v0.3.0）

- **默认是空人设**：`EMPTY_PERSONA` 只保留 `name = 鲸鱼酱`，`identity`、`tone`、`signature`、`knowledge` 为空，`rules`、`samples` 为空数组，`language = auto`；回复语气回落为产品默认的中性风格。
- **蓝白鲸鱼女仆是可选预设**：`PERSONA_PRESETS` 当前只有 `whale-maid`，只出现在 `GET /whale-chan/api/persona` 的 `defaults` / `presets` 只读投影里，不落库、不会自动启用。启用必须由主人点「载入预设」→ 检查 → 保存（`PUT settings/persona`）。
- **旧 persona 行保留**：升级不迁移、不覆盖已保存的人设；从未保存过人设（块缺失）的安装才采用空默认。想清空旧的自定义内容，需要手动「恢复默认（空人设）」并保存。
- **不改变存储与协议**：persona 仍是 `settings.persona` 单一来源，`state.db` schema 仍是 2；新增的两个字段只是接口投影，旧 host/旧 panel 忽略即可。预设正文与来源见 [014 人设默认值与预设](014-persona-defaults.md)。

### 5.3 会话归档与恢复（v0.4.0）

- **归档集合由 DSH 持有**：插件只读 `workspaceRegistry.archivedSessionIds`、调用 `archiveSession` 并枚举 registry/sessionPersistence；没有自己的归档表，`state.db` schema 仍为 2。
- **generation 存 KV，不是 schema**：`session.reply-generation:<threadKey>` 与 `session.worker-generation:<base>` 两行只增不减。`g0` 与 v0.3.0 的会话 id 逐字节一致，所以**升级不换会话**；只有归档（或被闸门拒绝）才前进到 `g<n>` / `<base>-g<n>`。
- **回退到 v0.3.0 兼容但会失去自愈**：旧版本忽略 generation 行，按 `g0` 解析会话；如果这些 `g0` 会话已被归档，旧版本的回复会被归档闸门挡住。回退前先读 [012 发布](012-release.md) §8 第 5 条。
- **归档不删数据**：目录、文件与会话日志保留，不提供 unarchive；在 DSH 手动 unarchive 旧会话不会回退 generation，旧上下文不会自动恢复。
- **定向真机验活（2026-11-04）**：归档后的 `ArchivedSessionGate` 行为已真机确认——归档当前回复器后，下一条群消息创建新会话并正常回复，旧会话目录保留；证据见 [WS14-live](test-reports/WS14-live.md)。仍未真机覆盖：`stopActivity=true` 的真实取消、任务 worker 归档、DSH 手动移除工作区后的重建/attach、单聊、多目标并发、Windows symlink/realpath（仅 fake 覆盖）；完整 T3/T4 未重跑；macOS/Linux 未验证。自动化限制见 [WS14 报告](test-reports/WS14.md) §7。

### 5.4 目标订阅与单聊修复（v0.5.0）

- **不改变存储**：`state.db` schema 仍为 2，设置仍 9 个 block / 58 个字段（v0.5.0 时为 57，WS16 新增 `reply.autoRetry`），没有新表、新列或迁移；`GET channel` 是只读投影，不落库。
- **`dm` 目标 id 的形态变了**：只接受对端 `userId` 或 `open:<openDingtalkId>`；`cid…=`（会话 ID）在本地即判 `invalid-target`。v0.4.0 及更早通过「单聊」发现写入的会话 ID 行，升级后订阅不会建立，必须改填——这是行为变更，不是数据迁移。
- **`mentionOnly` 从“存了但没用”变成生效**：群消息在目标行或全局 `reply.requireMentionInGroups` 任一为真时要求 @。原本靠“全局关闭 + 行内 true”回复全部群消息的配置，升级后只回 @ 消息；把行内开关关掉即可恢复。
- **订阅失败不再静默**：服务端拒绝被记进 `lastError`（脱敏、单行），`GET channel` 与目标页「订阅」列可见；连续 3 次无 `retry_after_seconds` 的拒绝会停止自动重启（`state=failed`），不再无限重试。
- **未真机验收（诚实标注）**：以上行为都由单元测试与假 `dws` 夹具覆盖（63 files / 880 tests），**没有**在真实账号上验收。`at-me` 订阅本身曾在修复前以 `--ephemeral` 探测到 ready；`at-me`+`group` 同群去重、单聊订阅与单聊出站回复仍未真机确认。真机清单见 [012 发布](012-release.md) §6 与 [WS15 报告](test-reports/WS15.md)。
- **回退**：回到 v0.4.0 可打开同一个库；`GET channel` 消失、`mentionOnly` 重新失效、单聊发现重新产出会话 ID 候选，但已改正的 `userId`/`open:<id>` 目标仍然可用。

### 5.5 回复预算与单次自动重试（v0.6.0）

- **行为变更：正文与引用预算分离**：`persona.maxReplyChars` 只约束正文；引用脚注有独立上限 `CITATIONS_MAX_CHARS`（600 码点），超出时逐行取舍（整行放得下就保留、放不下就跳过），一条都放不下则整体丢弃，**不会再截短或清空正文**。升级后，此前因引用过长被 `compose:empty` 丢掉的消息会开始正常回复；被跳过的引用在聊天里只表现为“少了几条参考”。
- **行为变更：默认一次自动重试**：`reply.autoRetry`（默认 `true`）让 `empty`/`sanitized_empty`/`model_error` 最多多调用一次模型，第二次仍失败才 `defer`；`timeout` 与 `echoes_system_prompt` 不重试。重试只累加 `decisions.attempts` 并写 host 日志，不覆盖分类 `reason`、不产生新的领域事件。关掉开关即回到“一次失败即 defer”。
- **无 schema / API / DSH 依赖变化**：`SCHEMA_VERSION` 仍为 2，管理 API 仍 21 条，`engines.dsh` 与 `dsh.compatibility` 不变，没有新依赖；设置字段 57 → 58（`reply.autoRetry`），`docs/011-settings-contract.md` 由生成器重出。
- **未真机验收（诚实标注）**：以上行为由单元测试覆盖（63 files / 894 tests），**没有**在真实账号上触发过“长引用 + 失败重试”。真实模型重试后的草稿差异、真实来源长度下的引用取舍表现均未实测，见 [WS16 报告](test-reports/WS16.md)。
- **回退**：回到 v0.5.0 可打开同一个 `state.db`；`reply.autoRetry` 对旧 schema 是未知字段，v0.5.0 启动时会把整个 `reply` block 回退默认并记 warning——回退前先记录该 block 的自定义值，回退后重新保存。回退后引用重新挤占正文预算，长引用场景会再次丢回复。

## 6. 兼容性判定流程

任何“支持某版本”的声明都必须留下证据：

1. **静态门禁**：`pnpm check`、`pnpm format:check`、`node scripts/check-pack.mjs` 全绿；
2. **安装**：在干净 profile 或干净机器上安装本地 bundle，重启后侧栏出现「DSH助理」，`GET /whale-chan/api/state` 200 且版本 `0.6.0`；「目标」页工作区块显示启用目标的目录（或「按会话创建」），`ready` 行还应有「归档会话」按钮、`per-conversation` 行没有；目标表右侧应有只读「订阅」列（`GET channel` 不可用时退化为提示条）；
3. **T0 只读**：`dws --version`、`dws auth status --format json` 的布尔字段；不订阅、不发送；
4. **T1 观察**：测试群订阅 + `dryRun`，确认事件解码、去重、断线重连、`unknown` 不重发；v0.5.0 起还要确认单聊订阅（`contact user search` 发现 → 保存 → `GET channel` 显示 `ready`）；
5. **T2 单条**：面板确认后向测试群发一条，确认 AI 角标、幂等键、回执；单聊回复要额外确认它走的是 `--open-dingtalk-id`（`lastError` 不应出现“用户无法解析”）；
6. **T3 全链路**：@我 → 分类 → 回复/任务 → 面板批准 → worker 会话 → 结果回帖；`at-me` 与群目标同订一群时确认普通消息按群行、@ 消息按 at-me 行；
7. 把版本、命令、输出摘要与截图写入对应的 `docs/test-reports/WSxx.md`（真机链路见 [WS8](test-reports/WS8-live.md)、工作区见 [WS9/WS10](test-reports/WS9-10.md)、归档/恢复见 [WS14](test-reports/WS14.md)、订阅/单聊见 [WS15](test-reports/WS15.md)），再更新本文与 `dsh.compatibility`。

未走完上述流程的版本，一律写“未验证”，不要写“应该可以”。
