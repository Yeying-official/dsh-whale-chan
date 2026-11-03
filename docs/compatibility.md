# 兼容矩阵

> 适用范围：`dsh-whale-chan-assistant` `0.1.0`（WS0–WS8 完成，Windows 真机 T0–T4 通过）。
> 最后核对：2026-11-03（Asia/Shanghai）。
>
> **权威顺序**：`package.json` 的 `dsh.compatibility` 与 WS8 的 T0–T4 记录 > 本文 > 其它说明。本文中的“已验证”只表示在本机 Windows 环境实际跑过，不表示在所有同版本环境都成立。

## 1. 结论

| 组件          | 已验证                                                        | 状态                                                            |
| ------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| DSH Desktop   | `0.2.1-rc.5`（Windows x64）                                   | **compatible**，`dsh.compatibility` 正式声明                    |
| DSH 其它版本  | 无                                                            | 未验证；不要假设向前/向后兼容                                   |
| `dws`         | `1.0.66`（`f215043e`，2026-10-28）                            | 群事件/发送回执已真机确认；单聊与其它版本仍 provisional         |
| Windows       | 10/11                                                         | 已实测（开发机与桌面端）                                        |
| 真机验收      | T0–T4（Windows 10/11、DSH `0.2.1-rc.5`、`dws` `1.0.66`）      | 通过；测试群目标已停用，见 [WS8 报告](test-reports/WS8-live.md) |
| macOS / Linux | 无                                                            | **未验证**，不作为支持承诺                                      |
| Node.js       | 24.15.0（开发）、24.21.0（DSH Desktop 自带）                  | 已实测；`engines` 允许 `^22.19.0 \|\| >=24.0.0`                 |
| 单实例        | 同一 `stateDir` 一个进程                                      | 已实现并由测试覆盖；崩溃后锁 stale 10 秒                        |
| 模型路由      | 宿主默认；或按回复器/执行器分别指定 provider + model + effort | 代码路径已测；未逐一验证所有 provider                           |

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

## 3. `dws` 版本

| `dws` 版本 | 状态           | 说明                                                                                                              |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `1.0.66`   | ✅ 实测        | 事件键、`event consume` 参数、`+messages-send`、`auth status` 按该版本 help/实测实现；Windows npm shim 已实际解析 |
| 其它 1.0.x | ⚠️ provisional | 解析器对 snake_case / camelCase 做别名兼容，但字段集合、回执字段与 `--ttl` 语义未逐版验证；先跑 T1 只读观察       |
| 更早版本   | ❌ 未验证      | 事件键或 `--ai-tag`/`--idempotency-key` 可能不存在；不要降级后直接订阅                                            |

WS8 已在 Windows + `1.0.66` 上确认：群事件键与 snake_case 扁平字段（`message_id`、`conversation_id`、`sender_open_dingtalk_id`、`content`、`event_time`、`create_time`）、`@ownerNick` 文本判定、`+chat-search`、`--ttl` 需 Go duration、非交互发送需 `--yes`、`openMessageId`/`deliveryStatus` 回执，以及重复幂等键返回 `CONFLICT_ERROR` 时按 `unknown` 处理。以下内容仍 provisional，真机 T1/T2 必须逐项核对（详见 [009 DWS 协议](009-dws-protocol.md) §9）：

- 单聊（o2o）事件链路，以及 `+chat-list --types p2p` 的响应结构与分页；
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

## 6. 兼容性判定流程

任何“支持某版本”的声明都必须留下证据：

1. **静态门禁**：`pnpm check`、`pnpm format:check`、`node scripts/check-pack.mjs` 全绿；
2. **安装**：在干净 profile 或干净机器上安装本地 bundle，重启后侧栏出现「鲸鱼酱」，`GET /whale-chan/api/state` 200；
3. **T0 只读**：`dws --version`、`dws auth status --format json` 的布尔字段；不订阅、不发送；
4. **T1 观察**：测试群订阅 + `dryRun`，确认事件解码、去重、断线重连、`unknown` 不重发；
5. **T2 单条**：面板确认后向测试群发一条，确认 AI 角标、幂等键、回执；
6. **T3 全链路**：@我 → 分类 → 回复/任务 → 面板批准 → worker 会话 → 结果回帖；
7. 把版本、命令、输出摘要与截图写入 `docs/test-reports/WS8.md`，再更新本文与 `dsh.compatibility`。

未走完上述流程的版本，一律写“未验证”，不要写“应该可以”。
