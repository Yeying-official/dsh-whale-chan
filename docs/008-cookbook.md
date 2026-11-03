# 008 开发手册

> 状态：WS7 补全。面向在本仓库做二次开发或评审的人；安装与发布见 [012 发布](012-release.md)，架构见 [007 架构](007-architecture.md)。

## 1. 环境

- Node.js 24（`engines` 允许 `^22.19.0 || >=24.0.0`，但只在 24 上验证）。
- pnpm 11.4.0（`packageManager` 固定；`pnpm install --frozen-lockfile` 必须可复现）。
- Windows 10/11 为当前验证平台；macOS/Linux 未验证，见 [兼容矩阵](compatibility.md)。
- DSH 包固定 `0.2.1-rc.5`；不要在未评估 `dsh.compatibility` 的情况下自行升级。

## 2. 常用命令

| 命令                 | 用途                                                      |
| -------------------- | --------------------------------------------------------- |
| `pnpm install`       | 安装锁定依赖                                              |
| `pnpm typecheck`     | `tsc --noEmit`                                            |
| `pnpm test`          | Vitest 全量测试                                           |
| `pnpm build`         | tsdown 生成 `lib/index.js` 与 `lib/client.js`             |
| `pnpm check`         | typecheck → test → build（提交前必须绿）                  |
| `pnpm format:check`  | Prettier 检查；必要时 `pnpm exec prettier --write <file>` |
| `pnpm pack:check`    | manifest、图标、files 与 `npm pack` 产物检查              |
| `pnpm docs:settings` | 从 `fields.ts` 重新生成 `docs/011-settings-contract.md`   |

## 3. 分支与工作区

- 一个工作流一个分支 + 一个 worktree；不要在主 checkout 里切分支，也不要在共享目录里并行改同一文件。
- 分支命名 `feat/wsN-...`、`fix/...`、`docs/...`；合并用 `--no-ff`，合并提交写清工作流。
- 提交遵循 Conventional Commits；一个提交只做一件事。提交前 `git status --porcelain` 必须为空。
- 本仓库的 `main` 由编排方维护；实现分支不自动合并、不 push、不安装 profile。

## 4. 分层与边界

```text
client → shared
channel / brain / executor → core → shared
app（存储、effect、HTTP、组合根）→ core / shared / Node
```

- `src/core`：纯领域类型与 `Engine`，零 I/O，不 import `node:*`、`@deepseek-ai/*` 或其它层。
- `src/shared`：设置 schema、字段表、API 合约、视图模型、边界常量；浏览器与 Node 通用，不含 Node 内置模块。
- `src/app`：SQLite、迁移、effect 队列、pass、设置服务、HTTP、组合根；只有 `runtime.ts` / `dingtalk-channel.ts` 可以 import channel/executor。
- `src/channel`：唯一启动 `dws` 子进程的层；不做领域决策、不写 Store。
- `src/brain`：人设、提示、分类、检索预算、策略与限流；不直连 I/O，不 import DSH 包。
- `src/executor`：DSH 会话与任务执行；不直接发钉钉消息、不写领域存储。
- `src/client`：面板；只依赖 shared 类型与字段表，不导入宿主实现。

`tests/contract.spec.ts` 会强制这些方向；新增跨层调用前先想清楚是否应该走 app 的窄接口。

## 5. 新增一个设置字段

1. `src/shared/settings.ts`：加 Zod 字段、默认值与边界（数值边界优先引用 `src/shared/limits.ts`）。
2. `src/shared/fields.ts`：加字段路径、类型、label/hint key、范围/选项；字段表是面板表单的唯一来源。
3. `locale/zh.json`、`locale/en.json`：加 label/hint，两个 key 集合必须一致。
4. `pnpm docs:settings` 重新生成 `docs/011-settings-contract.md`。
5. 跑 `pnpm test`：契约测试会检查 schema ↔ fields ↔ locale ↔ 文档一一对应；设置服务测试会检查默认值与 revision。
6. 如果字段影响运行时行为，补对应单元/集成测试；不要只改 schema。

## 6. 新增一条管理 API

1. `src/shared/api.ts`：在 `ApiContract` 与 `API_ROUTES` 中同时加方法/路径；保持 `API_PREFIX` 与 `x-whale-chan-request` 守卫。
2. `src/shared/models.ts`：定义请求/响应视图；不要让客户端直接看到领域对象。
3. `src/app/http.ts`：实现 handler，统一错误码映射（`missing` 404、`invalid` 400、`refused` 409、未就绪 503）。
4. `src/app/store-read.ts`：只读查询加分页与行映射；写操作必须走 `Engine` 命令，不在 handler 里直接写库。
5. `tests/api-routes.spec.ts` / `tests/task-actions.spec.ts`：覆盖成功、分页、错误码与同源守卫。
6. 更新 `docs/011` 的“管理 API 变更”与 `docs/005` 的页签路由表。19 条是当前冻结数量；新增端点属于合约变更，需要评审。

## 7. 新增一个面板页签或交互

1. `src/client/pages/<name>.tsx`：只通过 `src/client/api.ts` 调 HTTP，不 import 宿主实现。
2. `src/client/tabs.ts` 与 `app.tsx`：注册页签、顺序、hash/localStorage 行为。
3. `locale/{zh,en}.json`：所有文案走 `ctx.locale`；`src/client/**` 不写中文字面量。
4. `tests/client-*.spec.tsx`：用 `client-harness.tsx` 渲染真实 App，只 mock `fetch`；断言请求路径/请求体、错误态、键盘与焦点。
5. 交互要覆盖加载、空态、400/403/404/409/503、取消与卸载；新增危险操作要有确认与说明。
6. 更新 `docs/005`；涉及 API 的同步 `docs/011`。

## 8. 测试策略

- **领域/存储**：纯内存或临时 SQLite；断言事务、幂等、状态机与回滚。
- **通道**：`tests/fixtures/fake-dws.mjs` 模拟 NDJSON/退出码/回执；不启动真实 `dws`，不发真实消息。
- **brain**：stub `ModelPort` / `ResearchPort`；覆盖分类失败、低置信、回复清洗、限流、防环、静默。
- **执行器**：fake `SessionHost`；覆盖批准门、工作区、模型路由、超时/取消、重试、回调次数。
- **API**：真实 handler + 临时 Store；覆盖 19 条路由、错误码、分页、同源头。
- **客户端**：真实组件 + mock fetch；覆盖七页签、批准流、409 恢复、i18n、无障碍。
- 不把真实账号、群 ID、消息正文写进夹具或快照；测试产物不进 git。

## 9. 打包与发布

- `package.json.files` 只发布 `lib`、`assets`、`prompts`、`locale/*.json`、`cordis.patch.yml`、`README.md`、`LICENSE`；`src`/`tests`/`docs` 不随包。
- 当前 `npm pack` 为 15 个 artifacts；改 `files` 必须同步 `scripts/check-pack.mjs` 的期望与文档。
- `cordis.patch.yml` 同时声明宿主行与两套 agent preset；改 preset 的工具集要更新 `tests/presets.spec.ts` 与 `docs/006` §5。
- 版本 bump、tag、干净 profile 安装与回滚见 [012 发布](012-release.md)；本文不重复发布步骤。

## 10. 文档同步

- 改设置字段 → [011 设置合约](011-settings-contract.md)；
- 改协议/事件/发送 → [009 DWS 协议](009-dws-protocol.md)；
- 改面板 → [005 面板](005-panel.md)；
- 改分层/effect/outbox → [007 架构](007-architecture.md)；
- 改安全边界 → [013 安全基线](013-security.md)；
- 改安装/兼容/版本 → 根 README、[兼容矩阵](compatibility.md)、[012 发布](012-release.md)。

文档与实现不一致时，先判断哪边是错的：安全/状态机/合约以测试与冻结合约为准，叙述性文档跟随实现修正。

## 相关文档

- [003 执行](003-execution.md)
- [005 面板](005-panel.md)
- [007 架构](007-architecture.md)
- [009 DWS 协议](009-dws-protocol.md)
- [011 设置合约](011-settings-contract.md)
- [013 安全基线](013-security.md)
