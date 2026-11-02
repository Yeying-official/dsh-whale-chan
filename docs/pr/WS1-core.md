# WS1 · core 领域层、SQLite 存储、Effects 与 Passes

- 分支：`feat/ws1-core`（基于 `feat/ws0-bootstrap`）
- 范围：`src/core/**`、`src/app/{store,store-read,migration,effects,passes,kv}.ts`、对应测试与文档
- 不做：通道（dws 子进程）、人设、执行器、HTTP 路由、UI、设置持久化、目录锁

## 1. 目标

把 WS0 的类型占位变成可测试的领域实现，并提供后续工作流真正需要的持久化与调度地基：

1. 一个同步、事务化、零 I/O 的 `Engine`：消息进入 → 决策 → 草稿/发送 → 任务批准 → 派工 → 结果。
2. `node:sqlite` 存储：版本化 schema、聚合往返、只读查询、损坏 JSON 的可诊断错误。
3. 持久 effect 队列：至少一次投递、指数退避、`Later` 延后、死信、并发上限，且重排不丢任务。
4. pass 调度器：周期触发、单飞、异常隔离、可注入时间、可收敛停止。

## 2. 设计

### 2.1 core

| 文件        | 职责                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| `model.ts`  | 只读领域类型（Message/Thread/Decision/Draft/Task/Approval/Assignment/Outbound） |
| `errors.ts` | `UserError` + 稳定错误码（`missing` / `refused` 分类）                          |
| `ports.ts`  | `Repositories`（同步 + `atomic`）、`Ids`、`Clock`、领域事件、`EngineOptions`    |
| `engine.ts` | 唯一写入口；每个命令一个事务；查询不开事务；事件提交后投递                      |
| `index.ts`  | 公开出口                                                                        |

`Engine` 不持有数据库、日志器、定时器；依赖全部注入，内存仓储即可完整测试。

### 2.2 领域状态机

- Decision：`queued → classified → drafted → sending → sent|send_unknown|send_failed`；`queued → ignored`；`queued → task_created`；`queued|classified → deferred`。
- Task：`awaiting-approval → approved → running → succeeded|failed`；`rejected`、`cancelled`、`expired` 为终态。
- 批准必须同时得到 pending Approval、`at < expiresAt` 和非空 workspace；三张表的写入共享一个事务。
- `assignmentEnded` 只接受匹配的 `assignmentId` 与 `running` 状态，迟到的成功上报不能复活已取消任务。

### 2.3 存储

- `Store.open(stateDir)`：`<stateDir>/state.db`，WAL + `synchronous=FULL` + `foreign_keys=ON` + `busy_timeout=5000`。
- `PRAGMA user_version` 记录 schema（当前 1）；`migrate()` 前向、幂等；更新的数据库直接拒绝。
- 每个聚合一份 JSON 列 + 标量索引列；JSON 读取失败抛 `StoreCorruptionError(table, column, id)`。
- `atomic` 使用 `BEGIN IMMEDIATE`，嵌套调用抛错；`trimThread` 只裁消息。
- `store-read.ts` 提供分页只读查询；行映射与 JSON 解码由读写共用。

### 2.4 Effects

- 表 `effects` 随 schema v1 建立；部分唯一索引 `(kind, key) WHERE state IN ('waiting','running')`。
- 到期按 `due_at`、行序；失败退避 `min(5min, base×2^(attempts-1)) + ≤10% 抖动`。
- `Later` 延后 1 秒、不计数；达到 `maxAttempts` → `dead` 并保留错误。
- **运行中重复 enqueue**：受部分唯一索引约束，同键不能同时存在两条活动行，因此实现为覆盖载荷 + `generation + 1`，当前尝试结束后该行回到 `waiting` 并以新载荷重跑；当前尝试不会删除新载荷。测试 `keeps a re-enqueue that arrives while the effect is running` 覆盖此语义。

### 2.5 Passes

`register(name, run, { intervalMs, runAtStart })`；`tick(now)` 注入时间；同一 name 单飞；异常交给 `onError` 且不中断其他 pass；`start/stop` 管理定时器并等待进行中的轮次。

### 2.6 与 WS0 共享合约的偏差（均为内部细化）

- `Decision` 增加 `confidence`，`Task` 增加 `reason`，`Assignment` 去掉占位字段并采用评审定义；数据库相应增加 `decisions.confidence`、`tasks.reason`、`messages.sender_open_id` 三列。
- `approveTask` 的选项包含 `workspace`（评审文字中「workspace 由调用方给」）。
- `classify(task)` 在缺少标题或 TTL 时抛 `UserError`（`missingTaskDetail` / `missingApprovalTtl`），事务回滚。
- 迟到批准（`at >= expiresAt`）拒绝为 `approvalExpired`，与 [010 设计摘要](../010-design.md) §4.2「迟到批准无效」一致。
- 取消待批准任务时，其 pending Approval 记为 `expired`（请求失效），已批准的派工结束为 `cancelled`。
- `src/core/index.ts` 从「零 import」放宽为「只 import 本层与 `../shared` 纯类型」，契约测试相应改写并说明原因。

## 3. 风险

| 风险                                   | 说明                                                          | 缓解                                                                                     |
| -------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --- | ----------------------------- |
| 运行中重排与部分唯一索引的张力         | 索引不允许同键两条活动行，「插入新 waiting 行」与索引定义冲突 | 采用 generation 覆盖 + 结束后回到 waiting，语义上等价且可测；已在代码注释与 007 文档说明 |
| `node:sqlite` 在 Node 22/24 的实验状态 | API 稳定但仍有实验告警/未来微调                               | 只使用 `DatabaseSync`/`StatementSync` 基本 API；`engines` 已限 `^22.19                   |     | >=24`；测试在 Node 24.15 通过 |
| 无目录锁                               | 两个进程同开同一 stateDir 会竞争 WAL 写锁                     | 锁按计划留给 WS5；`busy_timeout` 提供短时重试                                            |
| 迁移只有 v1                            | 尚无历史数据                                                  | 迁移框架按版本数组实现，后续只需追加一步                                                 |
| 事件持久化未接线                       | `Engine.emit` 目前无人订阅                                    | `Store.appendEvent` 已提供，WS2 组合根接线；默认仅测试使用                               |
| `assignmentEnded` 不写 `sessionId`     | WS1 的派工在启动时没有会话 ID                                 | 由 WS2 在会话创建后扩展命令或写回，当前 `sessionId` 保留 null                            |

## 4. 测试证据

- `pnpm check` 全绿：typecheck、103 个测试、build。
- 新增 63 条测试：engine 21、invariants 13、store 13、effects 10、passes 6（另有 `contract.spec.ts` 新增 1 条分层检查）。
- 5 个变异实验均被对应测试杀死（详见 [WS1 测试报告](../test-reports/WS1.md) §3）。
- 覆盖：幂等、批准门、回滚、过期、取消、计数、时钟注入、schema/索引/迁移、损坏 JSON、分页/裁剪/KV、effects 顺序/并发/重排/退避/Later/dead/drain、passes 间隔/单飞/隔离/停止。

## 5. 影响面

| 区域                                                                                 | 影响                                                                                         |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `src/shared/*`                                                                       | 未修改（冻结）                                                                               |
| `src/app/settings.ts`、`http.ts`、`src/index.ts`、`cordis.patch.yml`、`package.json` | 未修改                                                                                       |
| `src/app` 新增                                                                       | `store.ts`、`store-read.ts`、`migration.ts`、`effects.ts`、`passes.ts`、`kv.ts`              |
| `src/core`                                                                           | 从占位类型改为完整领域实现；`index.ts` 公开出口                                              |
| 测试                                                                                 | 新增 fixtures 与 5 个 spec；`contract.spec.ts` 的分层规则放宽并加严（禁止 node:/DSH/app 层） |
| 文档                                                                                 | 001/003/007 重写，010 同步状态机与依赖说明；新增本 PR 文档与测试报告                         |

后续工作流的接口假设：

- WS2 通过 `src/core/index.ts` 使用 `Engine`、`Repositories`、`Clock`、`Ids`；用 `Store.open` 与 `Effects`/`Passes` 组合运行时；不直接写表。
- WS4 通过 `store-read` 查询，通过 `Engine` 命令改变任务状态；不接受 HTTP handler 直接改库。
- WS5 使用 `Kv` 或新增迁移；不得改变 WS1 状态机与 schema v1 语义。
