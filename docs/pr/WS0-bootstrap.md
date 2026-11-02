# WS0 · 仓库骨架与 rc.5 API spike

- 分支：`feat/ws0-bootstrap`
- 基线：`main`
- 状态：Review round 1 修复完成；**未合并、未推送、未由实现方安装到 profile**。
- 关联文档：[测试报告](../test-reports/WS0.md)、[rc.5 spike](../spike-rc5.md)、[设计摘要](../010-design.md)。

## 目标

建立一个可构建、可测试的 `dsh-whale-chan-assistant` Cordis bundle 骨架，冻结前后端共享的设置、字段与管理 API 合约，并用真实的 rc.5 类型和运行中 Host 核对后续要用的服务。

WS0 **不**实现钉钉通道、发送、任务、审批、检索或持久化；**不**连接真实钉钉，也**不**修改用户 profile。设置写入只是 WS0 的内存契约探针。

## 方案

1. 使用 DSH `0.2.1-rc.5`、Cordis `4.0.5`、Schemastery `3.18.5` 的精确版本，禁止 `latest`/范围漂移。
2. `src/shared` 冻结 9 个设置 block、57 个字段、19 个管理 API 端点、视图模型和边界常量。
3. `src/core` 只保留无 import 的领域类型骨架；`src/app` 提供最小 Runtime、部署 Config、状态路由，以及带 revision 的内存设置/只读人设契约。
4. `src/client` 用 tsdown CJS + `window.__ModuleLoader__.load` 输出，注册 `sidebar.panellist` 和 `main` 的 `whale-chan` 面板；状态页处理加载、在线、离线、错误和 503。
5. 所有管理请求要求 `x-whale-chan-request: 1`；客户端统一携带，缺失时 403 且不回传 `stateDir`。
6. 测试从 schema、fields、locale、API 表、文档、分层源码、真实 HTTP 响应和 revision 冲突多个方向验证。
7. 打包检查验证 manifest、图标、files 白名单（含未来 `prompts/`）和 `npm pack --dry-run` 的真实内容。

## 变更范围

- 宿主：`src/index.ts`、`src/app/{runtime,deployment,http,settings,views}.ts`、`src/core/index.ts`
- 共享：`src/shared/{settings,fields,api,models,limits}.ts`
- 客户端：`src/client/*`、`locale/{zh,en}.json`
- 工程：`tsdown.config.ts`、`tsconfig.json`、`vitest.config.ts`、`scripts/*`、`.githooks/commit-msg`
- 文档：`docs/000`–`docs/013`、spike、字段表、PR/测试报告

## 测试证据

```text
pnpm install --frozen-lockfile  -> Already up to date
pnpm typecheck                  -> exit 0
pnpm test                       -> 4 files, 35 tests passed
pnpm check                      -> typecheck + test + build, exit 0
pnpm build                      -> lib/index.js, lib/client.js, lib/index.d.ts
node scripts/check-pack.mjs     -> pack check passed: 10 artifacts, icon 711 bytes
pnpm format:check               -> All matched files use Prettier code style
pnpm docs:settings              -> 57 fields
```

详细输出摘要、spike 结论、已知缺口和逐条自评见 [WS0 测试报告](../test-reports/WS0.md)。

## Review round 1 → 修复项与证据

| 项                     | 落点                                                                                  | 证据                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0.1 settings revision | `src/shared/api.ts`、`src/shared/models.ts`、`src/app/settings.ts`、`src/app/http.ts` | `GET settings` 返回 `SettingsView`；`PUT settings/:block` 缺 revision 为 400 `revision_required`，过期 revision 为 409 `settings_conflict` 且带 `actualRevision`；`tests/state.spec.ts` 覆盖。                |
| P0.2 删除双写人设      | `src/shared/api.ts`、`src/shared/models.ts`                                           | 删除 `PUT persona` / `PersonaUpdateRequest`；`GET persona` 保留只读；`tests/state.spec.ts` 验证 PUT persona 为 405。**注意：删除一个端点后实际为 19 个，不是审核意见中的 18；没有擅自删除另一个已批准端点。** |
| P0.3 客户端共享值      | `src/client/index.tsx`、`src/client/api.ts`、删除 `src/client/constants.ts`           | `PANEL_ID` 直接 import shared；`STATE_URL = apiUrl('GET state')`；契约测试断言 client 不出现字面量 `/whale-chan/api/`，并允许纯 shared 值导入。                                                               |
| P0.4 同源头            | `src/shared/api.ts`、`src/app/http.ts`、`src/client/api.ts`                           | 所有管理请求要求 `x-whale-chan-request: 1`；无头 403 且响应不含 `stateDir`；OPTIONS 预检关闭；HTTP 测试覆盖。                                                                                                 |
| P0.5 stateDir 边界     | `src/app/runtime.ts`                                                                  | `~`、`~/x`、Windows 主目录形式、绝对路径通过；相对路径明确抛错；测试覆盖。                                                                                                                                    |
| P0.6 打包白名单        | `package.json`、`scripts/check-pack.mjs`                                              | files 加入 `prompts`；脚本在目录存在且有文件时校验 `npm pack` 包含 `prompts/`。                                                                                                                               |
| P0.7 文档编号          | `docs/009-dws-protocol.md`、`docs/013-security.md`、README、`docs/011`                | 安全文档改为 013；新增 009 DWS 协议占位；索引/链接/契约测试同步为 14 个文档。                                                                                                                                 |
| P1.8 魔法数            | `tests/contract.spec.ts`                                                              | 删除 `toHaveLength(57)`；schema↔fields 双向比较保留。                                                                                                                                                        |
| P1.9 启动失败与 inject | `src/index.ts`                                                                        | `await runtime.ready` 失败先 `ctx.logger.error(...)` 再抛出；`inject` 改为普通数组。                                                                                                                          |
| P1.10 spike 真机结论   | `docs/spike-rc5.md`                                                                   | 记录 desktop profile 安装、Config schema、客户端加载、侧栏/面板渲染和 state 200；只保留真实 dws 事件/发送为未验证。                                                                                           |
| P1.11 默认值决策       | `docs/010-design.md`                                                                  | 写入 `quietHours.enabled=true`（22:00–08:00）、`replyDuringQuiet=false`，以及无目标时空转、无副作用。                                                                                                         |

## 风险与未决

- **真实 dws 未接入**：WS0 不启动 dws、不订阅、不发送；T0–T3 真机护栏仍是设计约束。
- **WebServer.port 差异**：rc.5 中端口可能为 `undefined`；未来的同源校验需要 `getOrigin()` 或显式判空。
- **设置只存在内存**：WS0 的 revision 行为是契约探针，重启后恢复默认；持久化留到 WS4。
- **同源头的新行为未在 profile 重装后复验**：审核方的真机验证针对安装版本；修复后的 header 路径由本地 HTTP 测试覆盖，建议合并前在隔离 profile 再点一次面板。
- **端点计数分歧**：删除 `PUT persona` 后为 19；审核意见写 18，未擅自再删端点，等待确认。

## 文档同步

- [x] `docs/010-design.md` 已写完整中文设计摘要和默认值决策
- [x] `docs/spike-rc5.md` 已更新真机验证结论
- [x] `docs/011-settings-contract.md` 可从字段表重新生成
- [x] `docs/009-dws-protocol.md` 已新增
- [x] `docs/013-security.md` 已由 009 改名
- [x] 测试报告已追加 Review round 1 复跑
- [x] 未提交 token、clientSecret、真实消息或用户标识
- [x] 未执行钉钉订阅或发送

## 审查提醒

不要合并、不要推送到远端、不要由实现方安装 bundle；等待 Review round 2。
