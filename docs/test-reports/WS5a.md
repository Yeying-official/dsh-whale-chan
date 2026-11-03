# WS5a 测试报告

- 环境：Windows，Node `v24.15.0`，pnpm `11.4.0`，vitest `4.1.8`
- 分支：`feat/ws5a-app-api`（从 `main` `a1e3f84` 创建）
- 范围：持久化设置（schema v2）、19 条管理 API、任务批准/拒绝/取消/重试、状态目录锁
- 不启动：通道、执行器、流水线（WS5b）

## 1. 门禁命令与真实输出

```text
$ pnpm install --frozen-lockfile
Done in 18.3s using pnpm v11.4.0

$ pnpm typecheck
$ tsc --noEmit
（无输出，退出码 0）

$ pnpm test
 Test Files  37 passed (37)
      Tests  496 passed (496)

$ pnpm build
ℹ [CJS] lib\client.js  42.04 kB │ gzip: 12.48 kB
ℹ [ESM] lib\index.js  113.83 kB │ gzip: 29.35 kB
ℹ [ESM] lib\index.d.ts  0.75 kB │ gzip:  0.33 kB
✔ Build complete

$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!

$ node scripts/check-pack.mjs
pack check passed: 15 artifacts, icon 711 bytes
```

## 2. 测试增量

基线 `main` `a1e3f84`：33 个 spec、435 条。本次新增 4 个 spec 文件与 6 条既有 spec 用例，共 **+61 条**（496）。

| 文件                                    | 条数 | 覆盖                                                                                                                                                                                             |
| --------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/settings-service.spec.ts`        | 16   | 默认值、副本隔离、持久化重开、block/全局 revision、409 冲突、深合并与数组替换、未知键/越界、损坏行降级、schema 不匹配降级、meta 修复、history 与 source、`onChange`、v1→v2 幂等、v2 表/索引      |
| `tests/api-routes.spec.ts`              | 23   | state/overview/targets/threads/thread/tasks/task/settings/persona/health/audit 读取；settings 写入与 400/404/409；monitor/pause；channel 503/400/成功；403/404/405/413/400；分页边界；audit 分页 |
| `tests/task-actions.spec.ts`            | 10   | 批准（默认/显式/`~` 工作区、approval 校验、重复批准）、拒绝、取消、重试（新派工、保留结果、launch 重排、非 failed 拒绝、相对工作区、未知任务）                                                   |
| `tests/runtime-lock.spec.ts`            | 6    | 打开 db/settings/engine/effects、锁文件、facts、跨重启持久化、第二实例拒绝与释放后重开、stop 幂等、目录/数据库启动失败                                                                           |
| `tests/core-engine.spec.ts`（追加）     | +5   | 重试生成新 assignmentId、保留 result/approval、`task.retried`、Windows 绝对路径、四种非 failed 状态拒绝、空/相对 workspace、未知任务与非法时间                                                   |
| `tests/core-invariants.spec.ts`（追加） | +1   | 全量错误码分类表（missing/invalid/refused）钉死                                                                                                                                                  |

既有测试只做了两处适配：

- `tests/state.spec.ts`：改用 `createHttpHandler(httpDeps(runtime))`，并在 `afterEach` 停止 Runtime（否则 Windows 上删除被 SQLite 打开的状态目录会失败）。
- `tests/store.spec.ts`：把“拒绝更新 schema”的用例改为 `SCHEMA_VERSION + 1`（v2 已是当前版本），并让 `open()` 容忍测试自己关闭过的句柄。

## 3. 关键断言

- **设置写入单事务**：`update` 同时写 `settings`、`settings_history`、`settings_meta`；校验失败时 revision、history、内存值都不变（`tests/settings-service.spec.ts`）。
- **重启不丢**：关闭 Store 后重新 `Store.open`，`SettingsService` 读回 `paused: true` 与 revision 1。
- **迁移幂等**：v1 数据库打开后为 v2；手工再跑两次 `MIGRATIONS[1]` 不报错，`settings_meta` 仍只有一行。
- **19 条路由**：`tests/contract.spec.ts` 仍证明 19 条端点唯一；`tests/api-routes.spec.ts` 逐条覆盖。
- **批准产生真实派工**：`engine.task(taskId).assignmentId` 指向新的 `Assignment(pending)`，`effects.pending()` 里有一条 `launch`，payload 带 `assignmentId` 与 `workspace`。
- **重试仅 failed**：succeeded / cancelled / awaiting / running 全部 400 `notFailed`；失败任务重试后 `assignmentId` 变化，旧派工保持 `ended/failed`，`task.result` 保留。
- **锁**：第二个 Runtime 的 `ready` 拒绝（`already in use`），第一个不受影响；`stop()` 后 `.lock` 消失，新 Runtime 可打开。
- **不泄露**：health 响应不含 `stateDir`；channel 异常映射为通用 `channel_error`；未知异常 500 通用消息。
- **错误分类**：`UserError.category` 为 `missing`/`invalid`/`refused`，HTTP 分别 404/400/409；approve 非待批任务 409 `notAwaitingApproval`、非法 workspace 400 `invalidWorkspace`、未知 task 404、retry 非 failed 409 `notFailed`。

## 4. 已知限制

- `monitor.running` 固定 `false`，`health` 的 `channel`/`executor` 为 `degraded` + `unknown`：WS5b 接入后填充。
- `targets/discover|validate` 在 WS5a 返回 503；测试用 fake channel 覆盖成功路径。
- `launch` effect 只入队不执行：`tests/task-actions.spec.ts` 只断言 `waiting` 行与载荷。
- 未做真实 `dws` 调用与真实 DSH 会话（WS5b/WS8）。
