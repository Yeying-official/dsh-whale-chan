# WS0 · 仓库骨架与 rc.5 API spike

- 分支：`feat/ws0-bootstrap`
- 基线：`main`
- 状态：待人工审查；**未合并、未推送、未安装到任何 DSH profile**。
- 关联文档：[测试报告](../test-reports/WS0.md)、[rc.5 spike](../spike-rc5.md)、[设计摘要](../010-design.md)。

## 目标

建立一个可构建、可测试的 `dsh-whale-chan-assistant` Cordis bundle 骨架，冻结前后端共享的设置、字段与管理 API 合约，并用真实的 rc.5 类型和运行中 Host 核对后续要用的服务。

WS0 **不**实现钉钉通道、发送、任务、审批、检索或持久化；**不**连接真实钉钉，也**不**修改用户 profile。

## 方案

1. 使用 DSH `0.2.1-rc.5`、Cordis `4.0.5`、Schemastery `3.18.5` 的精确版本，禁止 `latest`/范围漂移。
2. `src/shared` 冻结 9 个设置 block、57 个字段、20 个管理 API 端点、视图模型和边界常量。
3. `src/core` 只保留无 import 的领域类型骨架；`src/app` 提供最小 Runtime、部署 Config、`GET /whale-chan/api/state` 和视图。
4. `src/client` 用 tsdown CJS + `window.__ModuleLoader__.load` 输出，注册 `sidebar.panellist` 和 `main` 的 `whale-chan` 面板；状态页处理加载、在线、离线、错误和 503。
5. 测试从 schema、fields、locale、API 表、文档、分层源码和真实 HTTP 响应多个方向验证，不只做字符串断言。
6. 打包检查验证 manifest、图标、files 白名单和 `npm pack --dry-run` 的真实内容。

## 变更范围

- 宿主：`src/index.ts`、`src/app/{runtime,deployment,http,views}.ts`、`src/core/index.ts`
- 共享：`src/shared/{settings,fields,api,models,limits}.ts`
- 客户端：`src/client/*`、`locale/{zh,en}.json`
- 工程：`tsdown.config.ts`、`tsconfig.json`、`vitest.config.ts`、`scripts/*`、`.githooks/commit-msg`
- 文档：`docs/000`–`docs/012`、spike、字段表、PR/测试报告

## 测试证据

```text
pnpm install --frozen-lockfile  -> Already up to date
pnpm typecheck                  -> exit 0
pnpm test                       -> 4 files, 30 tests passed
pnpm build                      -> lib/index.js, lib/client.js, lib/index.d.ts
node scripts/check-pack.mjs     -> pack check passed: 10 artifacts, icon 711 bytes
pnpm format:check               -> All matched files use Prettier code style
pnpm docs:settings              -> 57 fields
```

详细输出摘要、spike 结论、已知缺口和逐条自评见 [WS0 测试报告](../test-reports/WS0.md)。

## 风险与未决

- **实际页面加载未验证**：没有安装到 DSH profile，`sidebar.panellist` 和 `main` 的真实渲染只能在隔离 profile 中验证。
- **真实钉钉未接入**：WS0 不启动 dws、不订阅、不发送；T0–T3 真机护栏仍是设计约束。
- **WebServer.port 差异**：rc.5 中端口可能为 `undefined`；未来的同源校验需要 `getOrigin()` 或显式判空。
- **WS0 状态接口无鉴权**：仅提供只读、非敏感状态；未来写接口必须补同源与权限校验。

## 文档同步

- [x] `docs/010-design.md` 已写完整中文设计摘要
- [x] `docs/spike-rc5.md` 已记录实测签名、差异与未知项
- [x] `docs/011-settings-contract.md` 可从字段表重新生成
- [x] 测试报告已写
- [x] 未提交 token、clientSecret、真实消息或用户标识
- [x] 未执行钉钉订阅或发送

## 审查提醒

不要合并、不要推送到远端、不要安装 bundle；WS0 仅等待审查和后续工作流排期。
