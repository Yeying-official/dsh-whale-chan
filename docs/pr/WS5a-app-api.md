# WS5a · 持久化设置、管理 API 与状态目录锁

- 分支：`feat/ws5a-app-api`（从 `main` `a1e3f84` 创建）
- 范围：`src/app/{migration,settings,runtime,views,http,store,store-read,channel-port}.ts`、
  `src/core/{engine,errors,ports}.ts`、`src/index.ts`、
  `tests/{settings-service,api-routes,task-actions,runtime-lock}.spec.ts`、
  `tests/fixtures/http.ts`、`tests/{core-engine,state,store}.spec.ts`、
  `docs/{003,006,007,011}`、`scripts/generate-settings-docs.mjs`
- 不做：通道、人设、执行器、流水线的组合根接线（WS5b）；不改 `src/shared/*`（19 条 API 与视图模型冻结）、
  `src/client`、`src/channel|brain|executor`、`package.json`、`docs/PROGRESS.md`；未合并、未 push、未安装 profile

## 1. 目标

1. 把 WS0 的内存设置 canary 换成 SQLite 持久化设置服务（schema v2），重启不丢、revision 冲突可检测；
2. 实现冻结的 19 条管理 API 与全部视图，错误码稳定、不泄露路径/堆栈；
3. 批准/拒绝/取消/重试真正推进领域状态，批准与重试产生 Assignment 并投递 `launch` effect；
4. Runtime 打开 `state.db`、设置、引擎与 effect 队列，持有状态目录锁，启动失败可诊断；
5. 不提前接入 channel/executor/流水线。

## 2. schema v2（`src/app/migration.ts`）

- `SCHEMA_VERSION = 2`；`MIGRATIONS[1]` 为 v1→v2，前向、幂等（`CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`）。
- 新表：
  - `settings(block PK, value_json, revision, updated_at)`
  - `settings_history(id AUTOINCREMENT, block, value_json, revision, source, saved_at)` + `settings_history(block, id)` 索引
  - `settings_meta(id CHECK (id = 1), revision, updated_at)`，迁移插入 `(1, 0, now)`
- `Store.schemaVersion()` 读取 `PRAGMA user_version`；`migrate()` 逻辑不变。

## 3. 设置服务（`src/app/settings.ts`）

- `SettingsService(store, clock)`：`current()`、`view()`、`persona()`、`update()`、`patchInternal()`、`history(block?)`、`onChange()`、`warnings()`。
- 启动加载：逐 block 读取 JSON + `SettingsSchema` 校验；缺失/损坏/不匹配 schema 回退默认值并记录警告，启动不失败；`view()` 始终包含 9 个 block。
- 写入：`deepMerge`（块内深合并；数组/标量/null 替换）→ strict 校验 → **单事务** upsert `settings` + 追加 `settings_history` + 全局 revision+1；失败整体回滚。
- revision：block revision 是 `PUT settings/:block` 的并发令牌；全局 revision 存 `settings_meta`，缺失/落后时启动向上修复。
- `update` 的 history `source` 为 `panel`；`patchInternal` 默认 `internal`，不要求 expected revision。
- 保留 `SettingsConflictError` / `SettingsValueError` 的 `code` 与 HTTP 409/400 映射。

## 4. 领域：重试（`src/core`）

- 新增 `retryTask(taskId, { by, at, workspace, note? })`：仅 `failed`；`notFailed` 为新的 `refused` 错误码。
- 同一事务：新 `Assignment(pending)`、任务回到 `approved` 且 `assignmentId` 指向新派工；原 `Approval` 保持 `approved`；保留 `task.result`（供执行器引用上一轮结论）；emit `task.retried`。
- workspace 必须非空绝对路径（`missingWorkspace` / `invalidWorkspace`）；core 不引入 `node:path`，用 POSIX/盘符/UNC 三种形式判断。
- `cancelTask` 不允许取消 `failed`，因此“先失败再取消再重试”不构成状态。

## 5. 视图（`src/app/views.ts`）

| 视图                   | 来源                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `state`                | Runtime.info                                                                              |
| `overview`             | 设置（enabled targets）+ `store.read.counts()` + health                                   |
| `targets`              | `settings.targets.rows` + `TARGET_KINDS`                                                  |
| `threads` / `thread`   | `store-read` 分页 + 最近消息                                                              |
| `tasks` / `task`       | `store-read` 分页 / task + approval + 最近消息                                            |
| `health`               | stateDir 可写、db schema、lock、settings 警告；channel/executor 为 `degraded` + `unknown` |
| `audit`                | `events` 表分页，映射为 `AuditEntry`                                                      |
| `settings` / `persona` | `SettingsService`                                                                         |

领域与 wire 词表不同：domain `approved` → 面板 `queued`（已批准、等待执行；`src/shared/models.ts` 没有 `approved`）。`unreadCount`/`taskId` 领域没有对应事实，分别给 `0`/`null`。

## 6. HTTP（`src/app/http.ts`）

- `HttpDeps { runtime, settings, store, engine, effects, clock, channel? }`；`httpDeps(runtime)` 用 getter 惰性解析，路由可在启动完成前挂载。
- 保留同源头守卫、128 KiB body 限制、`failure()` 结构、404/405（带 `Allow`）。
- 分页：`limit` 1–100（缺省 50）、`offset ≥ 0`；非法参数 400 `invalid_query`。
- 任务动作：
  - `approve`：`workspace` 缺省 `tasks.workspaceRoot` 或 `<stateDir>/tasks` 加 taskId（`~` 展开、必须绝对）；`engine.approveTask` 成功后 `effects.enqueue('launch', taskId, { assignmentId, workspace })`。
  - `reject` / `cancel`：调用领域命令，返回 `{task, approval}` / `{task}`。
  - `retry`：仅 failed；默认 workspace 同上；成功后同样 `enqueue('launch', …)`。
- `targets/discover|validate` 走 `ChannelPort`；无通道 503 `channel_unavailable`，通道异常 400 `channel_error`（消息脱敏）。
- 错误映射：`HttpError` → 自身状态；`SettingsConflictError` → 409 + `actualRevision`；`SettingsValueError` → 400 + `issues`；`UserError` → 按 `category` 映射 `missing` 404 / `invalid` 400 / `refused` 409 + `code`/`values`；未知 → 500 通用消息。

## 7. Runtime（`src/app/runtime.ts`）

- 启动顺序：mkdir → `proper-lockfile` 锁 `<stateDir>/.lock`（stale 10 s）→ `Store.open` → `SettingsService` → `Engine`（事件写入 `events` 审计表）→ `Effects`（构造但不 start）。
- 第二个 Runtime 打开同一目录：`ready` 以 `already in use` 拒绝；`stop()` 释放锁并关闭数据库；启动中途失败会释放已获取资源。
- `facts()` 供 health 使用；`state()`/`health()` 直接返回冻结视图；`src/index.ts` 启动日志写明 schema/settings/lock，失败日志 + rethrow（HTTP 503）。

## 8. 与冻结合约的差异（实现侧处理，未改合约）

1. `src/shared/models.ts` 的 `TaskStatus` 没有 `approved`：domain `approved` 映射为 wire `queued`，查询参数 `status=queued` 反向映射为 `approved`。
2. `ApproveTaskRequest` 只声明 `approvalId?`，但 WS5a 要求 `note?`/`workspace?`：HTTP 层在运行时接受这两个字段，类型合约保持冻结。
3. `POST tasks/:id/retry` 合约没有 body：实现接受可选 `{ workspace?, note? }`（用于显式工作区与测试），缺省走默认工作区。
4. `Health` 没有 channel/executor 字段：以 `checks` 中 `channel`/`executor` 的 `detail: "unknown…"` 表示，且不参与总体 `status` 汇总，避免健康主机永远 `degraded`。
5. `UserError` 现分三类：`missing`（→404）、`invalid`（用户可纠正的输入，如 `invalidWorkspace`/`missingWorkspace`/`invalidTime`，→400）、`refused`（状态冲突，如 `notFailed`/`notAwaitingApproval`/`alreadyDecided`，→409）。HTTP 按 `category` 映射，分类表由 `tests/core-invariants.spec.ts` 钉住。

## 9. 门禁

见 [WS5a 测试报告](../test-reports/WS5a.md)。门禁以分支头为准；提交按模块拆分，中间提交不要求逐个独立绿（复审已确认）。

## 10. 未做 / 交给 WS5b

- 通道启动、订阅、发送与 `launch` effect handler（WS5a 只保留 `waiting` 行）；
- 执行器与流水线接线、`monitor.running` 的真实值、channel/executor 健康检查的真实结果；
- 设置变更到通道/执行器的热应用（`onChange` 已提供，WS5b 订阅）。
