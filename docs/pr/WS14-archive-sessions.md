# WS14 · 会话归档与工作区自愈

- 分支：`feat/ws14-archive-sessions`
- 基线：`main` `eda003f`（v0.3.0 发布后的文档提交）
- 提交：`7bdf048`（后端功能）、`9b8a423`（后端测试）、`5ad5a0a`（客户端 fixture 时间炸弹）、`0771c1a`（面板功能）、`fe2cf92`（前端测试）、`3e7c97d`（[验收报告](../test-reports/WS14.md)）、`ceb13a7`（文档）、`0650fb0`（v0.4.0 发布）、`872a9a0`（生成器同步）、`77810e7`（QA 回填）
- 状态：实现、测试与验收完成；**已合并到 `main` `d0ed2e6`**（`--no-ff`）；tag `v0.4.0` 打在本 docs 提交（本地、未 push）；代理未执行 merge/tag/push
- 关联：[005 面板](../005-panel.md)、[007 架构](../007-architecture.md)、[011 设置合约](../011-settings-contract.md)、[012 发布](../012-release.md)、[013 安全](../013-security.md)、[兼容矩阵](../compatibility.md)、[WS14 验收报告](../test-reports/WS14.md)

## 1. 需求

原文：

> 增加一个归档某一目标对应的工作区下的所有会话的功能，并且要求归档或在 DSH 手动移除该目标对应的工作区后，该目标群聊或会话在接收到新的消息后，会新建新的工作区或新的会话以保持功能正常。注意：按 git 方式管理版本变更；随版本变更更新项目文档；插件设计时，需注意前端设置界面与后端功能逻辑对应修改。

拆成三条可验证的目标：

1. **一次归档一个目标工作区的全部会话**，并把“哪些归档了 / 哪些本来就在归档里 / 哪些还在运行 / 哪些找不到 / 哪些失败”如实分区返回，不静默吞掉任何一类。
2. **归档后仍然可用**：当前回复器已被归档时，下一条钉钉消息不得被 DSH 的归档闸门挡住——回复器要落到新会话；worker 会话被归档时任务要落到新 worker 会话。
3. **工作区被 DSH 手动移除后仍然可用**：下一次回复/任务重建目录与 registry 记录；旧会话还能用就附着，不能用就换新会话，绝不改已有标题。

前端必须同步：有能力归档的入口、明确的确认、结果与错误都要在面板可见，而不是只有一个后端路由。

## 2. 设计

### 2.1 回复器 generation（身份）

- 会话 id 是摘要，不是标题：`replySessionIdForGeneration(threadKey, g)`，`g0` 的哈希输入是 `<threadKey>\u0000<WORKSPACE_LAYOUT_VERSION>`，与 v0.2.0 起的历史公式**逐字节一致**，所以从未归档过的安装升级后仍用原会话；`g>0` 追加 `\u0000g<n>`，得到不同摘要 → 不同会话，旧会话原样留着。
- 字段分隔用 NUL：threadKey 是用户数据，可打印分隔符会造成 `a:g1` 与“`a` 的第 1 代”撞车。
- 纯规则放在 `src/executor/reply-session.ts`（只有 `crypto`），app 层只负责**哪一代是当前代**。

### 2.2 预检与工作区重建（`src/app/session-recovery.ts`）

`ConversationSessions.prepareReply(threadKey, title, currentSessionId?)` 每轮消息前执行，且在 `runExclusive(threadKey, …)` 里：

1. `mkdir(path, {recursive, mode: 0o700})`；
2. `registry.resolveByPath(path)`；**只有缺失时才 `create`**，已有记录**绝不 `setTitle`**（任务与回复器共用记录，谁都不该改名）；
3. 记录是本轮新建的，就 `attachSession(candidate)` 尽力把旧会话挂回去：
   - 有显式缓存会话且 attach 失败 → `generation+1`（新记录无法拥有它，继续用它只会不可见）；
   - 只有隐式候选（重启后第一条消息，候选就是当前 generation 命名的 id）且 attach 失败 → **不**推进（`ensureSession` 会在新记录里创建它）；
4. 用 registry 的 `archivedSessionIds` 跳过已归档代（`MAX_GENERATION_STEPS = 32`），命中就持久化新 generation；
5. `mkdir`/`resolve`/`create` 任一失败 → 降级沿用当前 generation 并写 warning；归档轮换在这条降级路径上仍然生效（它只需要归档集合）。

返回值带 `sessionId/workspace/generation/rotated/workspaceRecreated/attached`，调用方无需再猜。

**会话身份与归档命令共用同一把 per-thread 锁**，所以“归档当前回复器并轮换”不会与“正在预检这条消息”交错：消息要么在归档前预检（它的会话随后被归档并被替换），要么在归档后预检（已经看到新一代）。

### 2.3 blocked 回合的单次重试（`src/executor/model.ts`）

预检与投递之间仍可能被归档（人在面板点了归档、或另一个进程）。`SessionModel` 每轮：

- 先 `prepareSession(...)`；返回的 id 与缓存不同 → `host.cancel(旧会话, 'replier session rotated')`、清空缓存、`fresh` 新建（即使旧会话是空闲的，也不能 resume 一个已归档会话）；
- 投递后回合以 `failed` 结束且 `detail` 含 `blocked`（DSH `ArchivedSessionGate` 的拒绝）→ 重新预检，用新幂等键 `<requestId>:r1` **重试一次**；第二次仍 blocked 就按普通失败上抛，不无限重试。

重试只覆盖“闸门拒绝”这一种失败：`host.deliver` 自身抛错、超时、中止都不在重试范围。

### 2.4 任务侧 worker generation（`src/executor/task.ts`）

- `ensureWorkerSessionId(baseSessionId)` 读 KV `session.worker-generation:<base>`，命中归档集合就前进到 `<base>-g<n>`；`g0` 仍是历史 id。
- 执行顺序改为：先解析 worker id → `prepareWorkspace` → `ensureWorkspace`（重建 registry 记录）→ `ensureSession`。这样一次取消（用 `run.sessionId`）在会话创建前就能定位到正确 id，且 worker 不会跑在一个 DSH 不认识的目录里。
- 任一步失败都走原有“未启动”失败路径，不伪造成功。

### 2.5 归档命令（`src/app/session-archive.ts`）

`POST targets/:id/archive-sessions`：

- **目标解析**：按 settings 的 `targets.rows` 用 `find` 取**首行**；没有该 id → `404 unknown_target`；`targetThreadKey` 为空（`@我`、`open:` 单聊）→ `400 per_conversation_workspace`，不猜一个目录。
- **候选并集**（任一来源都可能不完整）：
  1. registry `list()` 中路径与目标工作区相同的记录的 `sessionIds`（归档后记录仍在，账号最全）；
  2. `sessionPersistence.list()` 中 `header.cwd` 与目标工作区相同的会话 id（registry 记录可能被人在 DSH 里删掉）；
  3. 当前回复器 id（可能还没创建，那就如实进 `missing`）。
- **路径身份**：两边都过 `fs.realpath`（失败退回 `resolve`），用 `isSameWorkspacePath`（`path.relative` 语义，Windows 不区分大小写）比较；一次 pass 内缓存，避免重复 realpath。标题与模糊名称从不参与归属判断。
- **上限 500**：先稳定排序再截断，`current` 回复器永不被丢（它决定轮换）；`truncated`/`candidateCount` 如实返回。
- **分区**：`alreadyArchived`（在归档集合里）不重复调用；其余逐个 `archiveSession(id, {stopActivity})`，按错误名分类：`WorkspaceActiveSessionError` → `refused`（activity 归一化为 `{kind, items?: [{id,label?}]}`，未知字段丢弃）、`WorkspaceUnknownSessionError` → `missing`、其它 → `failed[{sessionId,error:'archive_failed'}]`（内部消息只进日志，不回传）。
- **轮换判据**：读完归档集合后重新读一次 `archivedSessionIds`，只有**当前**回复器在其中才 `rotateReplySession`。判据是“宿主现在说它在归档里”，不是“本次是否尝试过归档它”——早先的归档、DSH 手动归档、并发归档都能得到正确结果。
- **审计**：`workspace.sessions-archived`（`actor=owner`，见 `src/app/views.ts` 的 `OWNER_ACTIONS`），记录 threadKey、targetId、四类计数、`stopActivity`、`replySessionRotated`。

### 2.6 破坏性边界（设计即约束）

不删目录、不删文件、不删会话日志、不 unarchive、无回滚命令、不改已有标题。归档是“从可见面隐藏”，不是“删除”；会话与历史仍属于主人。

## 3. 外部契约

### 3.1 路由

```http
POST /whale-chan/api/targets/:id/archive-sessions
x-whale-chan-request: 1
content-type: application/json        # 可省略

{ "stopActivity": false }             # 可选；非布尔 → 400 invalid_body
```

响应 `200`：

```json
{
  "targetId": "…",
  "threadKey": "…",
  "workspace": { "path": "…", "title": "钉钉 · …" },
  "archived": ["…"],
  "alreadyArchived": ["…"],
  "refused": [{ "sessionId": "…", "activity": [{ "kind": "turn", "items": [{ "id": "…", "label": "…" }] }] }],
  "missing": ["…"],
  "failed": [{ "sessionId": "…", "error": "archive_failed" }],
  "replySessionRotated": true,
  "nextReplySessionId": "…",
  "stopActivity": false,
  "truncated": false,
  "candidateCount": 3
}
```

错误：

| HTTP | code                         | 触发                                         |
| ---- | ---------------------------- | -------------------------------------------- |
| 400  | `invalid_body`               | `stopActivity` 出现但不是布尔                |
| 400  | `per_conversation_workspace` | 目标是 `@我` 或 `open:` 单聊，没有单一工作区 |
| 403  | `forbidden`                  | 缺 `x-whale-chan-request: 1`                 |
| 404  | `unknown_target`             | settings 里没有该 target id                  |
| 405  | `method_not_allowed`         | 非 `POST`                                    |
| 503  | `state_unavailable`          | 运行时未装配 registry（API-only 模式）       |

候选的五类互斥且并集等于本次处理的候选；每个候选恰好出现在一类里。

### 3.2 契约计数

`API_ROUTES` **19 → 20**；设置仍 9 block / 57 字段；`state.db` schema 仍 2；无新依赖、无新设置字段、无数据库迁移。新增的 `ArchiveTargetSessionsRequest/Result`、`ArchivedSessionActivity`、`RefusedArchivedSession`、`FailedArchivedSession` 都在 `src/shared/models.ts`，面板与宿主共用同一份类型。

### 3.3 KV 键

| 键                                        | 值                  | 语义                             |
| ----------------------------------------- | ------------------- | -------------------------------- |
| `session.reply-generation:<threadKey>`    | `{ generation: n }` | 该会话当前回复器代；只在轮换时写 |
| `session.worker-generation:<baseSession>` | `{ generation: n }` | 该 worker 基 id 的代；归档后写   |

两个键都是“只增”的持久事实：重启、数据库重开都保留；旧版本不认识它们（按 `g0` 解析），所以回退安全。

## 4. 前端对应关系

| 后端事实                                          | 面板表现                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 新路由 `archive-sessions`                         | 目标页「工作区」表格新增「操作」列；只有 `mode: 'ready'` 的行有「归档会话」按钮                          |
| `per_conversation_workspace`                      | 该行只有「按会话创建」徽标，**不渲染按钮**，也不可能发出请求                                             |
| `stopActivity` 默认 false                         | 确认弹窗里的开关默认关；说明文字写明 true 会取消运行中的回复/任务                                        |
| 破坏性、不可撤销                                  | 弹窗正文先说明归档范围（含主人手建会话与任务会话），再列警告；必须点确认才发请求                         |
| `archived/alreadyArchived/refused/missing/failed` | 结果摘要五个计数；`refused` 列出 session id 与 activity 家族；`failed` 列出 session id 与错误码          |
| `truncated` / `candidateCount`                    | 警示条“只处理了一批（共 N 个候选）”                                                                      |
| `replySessionRotated`                             | 摘要尾部说明“下一条消息会用新会话”或“回复器未轮换”                                                       |
| 归档后 targets 投影变化                           | 成功后 `targetsApi.reload()`，但结果摘要留在弹窗内直到主人关闭                                           |
| 错误码                                            | `per_conversation_workspace` / `unknown_target` / `state_unavailable` 各有专用文案，其余复用 `errorText` |
| 无障碍                                            | 结果区 `role=status aria-live=polite`；按钮有 `aria-label`；弹窗支持 Esc 关闭并清空开关与结果            |

面板不新增页签、不新增设置字段：归档是目标页上的一个动作，作用于该行现有工作区。

## 5. 测试与证据

### 5.1 门禁（本 worktree 实跑）

| 命令                          | 结果                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `pnpm typecheck`              | exit 0                                                                  |
| `pnpm test`                   | **62 files / 849 tests** 全通过（基线 60 / 765，+84：后端 68、前端 16） |
| `pnpm build`                  | exit 0（宿主 ESM + 客户端 CJS）                                         |
| `pnpm format:check`           | 通过                                                                    |
| `node scripts/check-pack.mjs` | `15 artifacts`，icon 711 bytes，版本断言 `0.4.0`                        |

### 5.2 新增/修改的测试

| 文件                                   | 用例数 | 覆盖                                                                                        |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `tests/session-recovery.spec.ts`       | 26     | g0/g1 公式、持久化、attach/轮换、降级、per-thread 锁、worker generation、重开数据库         |
| `tests/session-archive.spec.ts`        | 23     | 候选并集/去重/路径身份、分区、stopActivity、轮换与幂等、审计、拒绝、破坏边界、500 上限、锁  |
| `tests/executor-model.spec.ts`         | 32     | 预检使用/取消重建、blocked 单次重试、二次 blocked 不重试、非 blocked 走原失败路径           |
| `tests/executor-task.spec.ts`          | 45     | ensureWorkspace 在 ensureSession 前、失败传播、prepared worker id、失败不启动               |
| `tests/api-routes.spec.ts`             | 30     | 新路由 200/400/404/405/403/503、stopActivity、分区与轮换                                    |
| `tests/contract.spec.ts`               | 13     | `API_ROUTES` 20 条、路径编码、唯一性                                                        |
| `tests/client-api.spec.ts`             | 8      | 归档客户端：编码 id、body、错误码                                                           |
| `tests/client-targets.spec.tsx`        | 21     | ready-only、确认前无请求、stopActivity body、结果/截断/轮换、4 类错误码、重试、Esc、pending |
| `tests/fixtures/workspace-registry.ts` | —      | 新增 registry/persistence 双替身                                                            |

### 5.3 独立验证

[WS14 验收报告](../test-reports/WS14.md) 记录：变更范围审计、门禁、18 项独立探针（generation、手动归档、工作区重建、降级、blocked、worker、HTTP、截断、跨会话隔离）、红队核对（P0-1/P0-2/P1-3/P1-4/P2-7 确认修复）。本版**未跑真机**：`ArchivedSessionGate`/activity 结构由 fake 按 `error.name` 模拟。

## 6. 独立评审发现并修复的 5 项

评审先于验收进行，发现的问题全部在本分支修复，并有对应测试钉住：

| #    | 问题                                                            | 修复                                                                                        | 证据                  |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------- |
| P0-1 | 预检与投递之间被归档，消息进入 blocked 回合并被当成普通失败丢掉 | `SessionModel` blocked 单次重试，新幂等键 `:r1`；`executor-model.spec.ts` 三个 blocked 用例 | `7bdf048` / `9b8a423` |
| P0-2 | 冻结契约里没有归档路由，功能只存在于服务层                      | 补 `API_ROUTES` 第 20 条 + handler + 错误映射；`api-routes.spec.ts`、`contract.spec.ts`     | `7bdf048` / `9b8a423` |
| P1-3 | 同一派工重跑会 resume 已归档的 worker 会话，被闸门挡住          | 持久 worker generation → `<base>-g<n>`；`executor-task.spec.ts`、`session-recovery.spec.ts` | `7bdf048` / `9b8a423` |
| P1-4 | 预检变成每轮消息的致命依赖，registry/mkdir 故障会打断对话       | `prepareReply` 失败降级沿用当前 generation；归档轮换仍生效；`session-recovery.spec.ts`      | `7bdf048` / `9b8a423` |
| P2-7 | 重启后第一条消息没有缓存会话，重建工作区时不 attach，丢上下文   | 无缓存时以当前 generation 的 id 作隐式候选并 attach；显式失败才轮换；测试两例               | `7bdf048` / `9b8a423` |

评审同时提出、本版**未完全解决**的两项（文档必须如实写明）：

- **P1-5 误伤/不可逆**：归档并集包含主人手建会话与别目标批准到本目录的任务会话；UI 文案与 owner 审计已覆盖，但没有 unarchive、没有回滚，审计只记计数不记 id 列表。
- **P2-6 截断**：`truncated`/`candidateCount` 已如实返回，但 >500 时已归档候选仍占名额，**重复调用不会推进尾部**。

## 7. 风险与未覆盖

- **真机未跑**：DSH Desktop 本轮未启动；`blocked` 由代码阅读（`ArchivedSessionGate` 在 `agent/pre-step` 拒绝）+ `FakeSessionHost` 脚本化验证，不是活体证据。
- **stopActivity 的真实取消未端到端**：只验证 flag 透传与 stop 分支；运行中的回复/任务被取消后的用户可见结果没有真机观察。测试替身 `FakeWorkspaceRegistry.archiveSession` 忽略 `stopActivity`，现有用例没有真正证明“活动会话被归档并发出 stop”。
- **二次 blocked 与任务侧竞态**：第二次仍 blocked 会显式失败（`ModelFailedError` → decision `deferred`，聊天里没有回复）；任务侧在 prepare→deliver 之间被归档没有单次重试，会显式报错。
- **>500 尾部**：见 P2-6；面板只说明“本次只处理一批”。
- **重复 target id**：settings 允许重复 id，服务用 `find` 取首行；未写测试。
- **`nextReplySessionId` 的轻微不一致**：它是本次轮换写入的 id；若该代此前已被手动归档，下一条消息的预检会继续前进到再下一代。
- **Windows 路径/symlink 规范化**：用 fake `realpath` 覆盖逻辑，未在真实 registry 上验证；macOS/Linux 未验证。
- **UI 无截图**：组件测试（jsdom）覆盖，没有浏览器截图或人工视觉核对。
- **归档不改变 DSH 兼容声明**：`engines.dsh` 仍 `^0.2.1-rc.5`，`dsh.compatibility` 仍只标记 `0.2.1-rc.5`；归档闸门行为由宿主提供，本插件只做适配。

## 8. 合并坐标

| 项              | 值                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 合并方式        | `--no-ff` 合并到 `main`（由协调者执行，代理未合并）                                                                       |
| `main` 合并提交 | `d0ed2e6`（`chore(merge): ws14 archive workspace sessions`）                                                              |
| 发布 tag        | `v0.4.0` 打在本 docs 提交（本地、未 push；代理未执行 tag/push）                                                           |
| 工作区          | 合并前与本次 docs 提交前 `git status --porcelain` 均为空                                                                  |
| 验收报告状态    | 已由 QA 回填（`77810e7`）：[WS14 报告](../test-reports/WS14.md) 的「文档随版本更新 = 已完成」；本文档代理不改 QA 报告正文 |
