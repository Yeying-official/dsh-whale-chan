# 项目进度与待办（暂停快照）

> 快照时间：2026-11-02 17:54（Asia/Shanghai）。
> 状态：**暂停**。无运行中的子智能体，无后台作业。
> 恢复方式：对编排会话发送 `continue`。

---

## 1. 总体完成度

| 工作流 | 状态 | 位置 |
| --- | --- | --- |
| WS0 骨架 + rc.5 spike + 两轮契约修复 | **完成并合并** | `main` `f1312c6` |
| WS1 core 领域 + SQLite store + effects + passes（含审核修复轮） | **已交付，待最终复审与合并** | `feat/ws1-core` `5bc1e4b`（9 个提交） |
| WS2 dws 通道 | 未开始 | 计划 worktree `E:/DSHWork/wt-ws2` |
| WS3 人设/提示/分类/检索/策略 | 未开始 | 计划 worktree `E:/DSHWork/wt-ws3` |
| WS4 任务执行器 + agent preset | 未开始 | 依赖 WS1/WS2/WS3 |
| WS5 设置持久化 / HTTP API 全量 / 收件箱 / 健康 | 未开始 | 依赖 WS4 |
| WS6 面板 UI 全页签 | 未开始 | 依赖 WS5 契约 |
| WS7 文档 / 安装 / 兼容矩阵 / CHANGELOG | 未开始 | 可与 WS6 并行 |
| WS8 端到端 + 真机 T0–T3 验收 | 未开始 | 最后收口 |

已安装状态：`dsh-whale-chan-assistant` 已装入 `desktop` profile（link 到本仓库），WS0 版本通过真机面板验证；WS1 尚未部署。

---

## 2. 分支与提交坐标

| 分支 | HEAD | 说明 |
| --- | --- | --- |
| `main` | `f1312c6` | WS0 合并提交：`chore(merge): ws0 bootstrap and frozen contracts` |
| `feat/ws0-bootstrap` | `b22118c` | 保留用于审计；内容已全部在 main |
| `feat/ws1-core` | `5bc1e4b` | 基于 `b22118c`，9 个提交，**未合并** |

WS1 提交：

```
f81677e feat(core): domain model and engine
01de240 feat(core): invariants and errors
25be3f5 feat(store): sqlite repositories and migration
ee1c028 feat(app): durable effects and passes
9bcc358 test: cover engine, store, effects and passes
a2fc813 docs: document domain, execution and architecture
b25692e fix(core): bind assignment session and numeric expiry
315c4a6 test: cover session binding, titles and offset times
5bc1e4b docs: record session binding, titles and effects semantics
```

---

## 3. 已验证的证据

- `pnpm check`（main）：typecheck 0 错误，39/39 测试，build 成功。
- `pnpm check`（feat/ws1-core）：typecheck 0 错误，**107/107 测试**（9 个文件），build 成功；`format:check` 通过；`pack:check` 通过。
- WS1 逐提交验证：`b25692e`=103、`315c4a6`=107、`5bc1e4b`=107；8 个变异实验（M1–M8）均被测试杀死。
- 安装：`plugin_manager install_bundle` → `application: applied`；宿主 Config 行 `status: schema`；客户端模块加载 id 正确。
- 真机面板：侧边栏「鲸鱼酱」可见；面板显示“已连接 / 0.1.0-dev.0 / `C:\Users\admin\.dsh-whale-chan` / 启动时间”。
- 同源守卫（真机 curl）：无 `x-whale-chan-request` → 403；带头 → 200；`GET settings` 返回 9 个 block。

---

## 4. 待办（恢复后按顺序执行）

### P0

1. **复审并合并 WS1**：复核 4 项修复（assignment 绑定 session、`InboundMessage.title`、ISO 偏移数值比较、`replyUnknown` 终态），跑 `pnpm check`，`git merge --no-ff feat/ws1-core`，合并提交用 Conventional 类型（如 `chore(merge): ws1 core domain`）。
2. **重载并复验插件**：`pnpm build`；`plugin_manager set_bundle` 关闭再开启（或重新 `install_bundle`）；页面刷新确认「鲸鱼酱」面板仍连接、`GET /whale-chan/api/state` 200。
3. **WS2（worktree）**：dws 进程 supervisor、NDJSON 归一化、目标编译/发现/校验、auth 探测、sender（AI 角标、幂等键、`unknown` 不重发）、`tests/fixtures/fake-dws.mjs`；禁止真实订阅/发送。文档 `009-dws-protocol.md` 必须区分“夹具已验证”与“真机待验证”。
4. **WS3（worktree，可与 WS2 并行）**：人设渲染、`prompts/*.md`、分类器 JSON 校验与兜底、回复草拟、检索适配（`web.search` 端口 + 预算/缓存/引用）、策略矩阵（静默时段、allow/block、限速、防环）；`ModelPort` 用 stub 测试。
5. **合并 WS2/WS3 → WS4**：执行器（每任务一个 DSH 会话）、两个 agent preset、工作区、取消/超时、结果合成；证明“无 Approval 零执行”。
6. **WS5**：设置持久化（替换 WS0 内存 canary）、19 条管理 API 全量、收件箱通知、健康、审计。
7. **WS6**：面板全页签（概览/会话/任务/目标/人设/设置/审计）、批准流、角标计数、zh/en、主题、无障碍。
8. **WS7**：README/SETUP/000–013、兼容矩阵、CHANGELOG、验收手册。
9. **WS8**：端到端 + 真机 T0（只读）→ T1（订阅观察，`dryRun`）→ T2（单条测试群发送）→ T3（@我全链路）；证据入 `docs/test-reports/WS8.md`。

### P1
- 合并 WS1 后更新 README 的“当前状态”与目录说明。
- 发布前补 `CHANGELOG.md`、版本 tag（`v0.1.0`）。

---

## 5. 恢复命令（编排侧）

```bash
cd /e/DSHWork/dsh-Whale-chan-Assistant
git switch main
git merge --no-ff feat/ws1-core -m "chore(merge): ws1 core domain"
pnpm check
pnpm build

# 重新加载已安装 bundle（二选一）
# plugin_manager: set_bundle(enabled=false) → set_bundle(enabled=true)
# 或 plugin_manager: install_bundle(target=E:\DSHWork\dsh-Whale-chan-Assistant)

# 并行工作流（不要在共享工作区切分支）
git worktree add E:/DSHWork/wt-ws2 -b feat/ws2-dws main
git worktree add E:/DSHWork/wt-ws3 -b feat/ws3-brain main
```

---

## 6. 已冻结的决策

| 决策 | 值 |
| --- | --- |
| 插件身份 | `dsh-whale-chan-assistant` /「鲸鱼酱 · 钉钉助理」/ 默认二次元助理语气 |
| 代回复披露 | 固定钉钉 AI 角标；不额外加前缀；v1 不提供关闭开关 |
| 批准通道 | 仅 DSH 面板 + 收件箱会话；钉钉 A2UI 卡片留 v0.3 |
| 管理 API | 19 个端点；`GET persona` 只读；`PUT settings/:block` 必带 revision，块内深合并 |
| 设置默认 | `quietHours.enabled=true`（22:00–08:00）、`replyDuringQuiet=false`、`dryRun=false` |
| 任务执行 | 无 `Approval(approve)` 不得创建 Assignment；迟到批准拒绝；取消后不可复活 |
| 发送未知 | `replyUnknown` 为终态，不自动重发，需主人核对 |
| effects | 保留 `UNIQUE(kind,key) WHERE state IN ('waiting','running')`；运行中 enqueue 覆盖 payload + `generation+1`，当前尝试结束后重跑 |
| 监听目标 | 运行时只用已解析的 `openConversationId`/`userId`，不在监听期按名字解析 |
| 真机测试 | 仅 `AI工程师孵化中心` 群；T0 只读 → T1 观察 → T2 单条 → T3 @我；全程 `dryRun/review` 先行 |

---

## 7. 未决项与风险

- **WS2 真实字段未验证**：`dws event --flatten` 的字段名、`@我` 判定、发送回执需 T1/T2 真机确认；夹具解析器在 WS2 标注为 provisional。
- **profile link 风险**：profile 指向仓库目录，`lib/` 随分支构建变化；工作流并行必须用 worktree，主仓库保持 `main`。
- **安装时 `cpu-features` 原生编译失败**：profile 内已有依赖的构建警告，与插件无关；安装仍 `applied`。
- **DSH rc.5 API 差异**：`WebServer.port` 可选、`dsh-client-ui-slots` 非客户端插件等，记录在 `docs/spike-rc5.md`。
- **schema v1 含 `messages.title`**：未发布，属首版 schema，无需迁移。

---

## 8. 记录规范（延续）

- 每个 WS：独立分支 + `docs/pr/WSn-*.md` + `docs/test-reports/WSn.md`；合并用 `--no-ff`。
- 改设置字段 → 同步 `docs/011-settings-contract.md`；改协议 → `docs/009-dws-protocol.md`；改面板 → `docs/005-panel.md`；否则不合并。
- 发布：SemVer + `CHANGELOG.md` + tag；兼容矩阵在 `package.json.dsh.compatibility`。
