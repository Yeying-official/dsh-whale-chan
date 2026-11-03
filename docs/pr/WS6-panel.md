# WS6 · 七页签管理面板

- 分支：`feat/ws6-panel`
- worktree：`E:\DSHWork\wt-ws6`
- 基线：`main` `8dc9b93`（WS5a 的 19 条管理 API）
- 状态：实现与测试完成，**未合并、未 push、未安装到任何 profile**。
- 关联文档：[面板说明](../005-panel.md)、[测试报告](../test-reports/WS6.md)、[设置合约](../011-settings-contract.md)、[架构](../007-architecture.md)。

## 1. 目标

把 WS0 的单页「连接状态」面板扩展为完整的管理面板：

1. 七个页签：概览 / 会话 / 任务 / 目标 / 人设 / 设置 / 审计；
2. 数据全部来自 WS5a 已冻结的 19 条 `/whale-chan/api/*` 路由；
3. 批准、拒绝、取消、重试与任务状态机一致，并在 `sessionId` 出现时打开 DSH 会话；
4. 目标、人设与每个设置 block 都用 `revision` 乐观并发保存，409 可恢复；
5. 中英双语、深色主题、可键盘操作、窄屏单列。

**不改宿主**：`src/app|core|shared|channel|brain|executor`、`src/index.ts`、`docs/PROGRESS.md` 均未修改。

## 2. 交付

| 区域       | 文件                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 数据层     | `src/client/api.ts`：`getJson/postJson/putJson`、`call` 路由调用、`useApi/useMutation/usePaged`、超时与取消、`ErrorBody` 解析 |
| 壳层       | `src/client/app.tsx`、`provider.tsx`、`tabs.ts`、`controls.tsx`、`client.css`                                                 |
| 通用表单   | `src/client/fields.tsx`：`FieldRow/TextField/NumberField/SwitchField/EnumField/ListField/RowsField/FormActions/RegistryField` |
| 视图       | `src/client/pages/{overview,threads,tasks,targets,persona,settings,audit}.tsx`                                                |
| 错误与预览 | `src/client/errors.ts`、`session.ts`、`status.ts`、`format.ts`                                                                |
| 文案       | `locale/zh.json`、`locale/en.json`（各 469 key，含全部新增 UI 文案）                                                          |
| 测试       | `tests/client-harness.tsx` + 9 个 `client-*.spec.ts(x)`，mock `fetch`，无真实请求                                             |
| 工程       | `package.json` / `pnpm-lock.yaml` 增加 `@testing-library/react`、`@testing-library/user-event`（jsdom 原已存在）              |

### 路由 → 视图

| 页签 | 路由                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 概览 | `GET overview`、`GET health`、`GET tasks?status=running&limit=100`、`GET audit?limit=5`、`POST monitor/pause` |
| 会话 | `GET threads`、`GET threads/:key`                                                                             |
| 任务 | `GET tasks`、`GET tasks/:id`、`GET settings`（工作区提示）、四个 `POST tasks/:id/*`                           |
| 目标 | `GET targets`、`GET settings`、`POST targets/discover`、`POST targets/validate`、`PUT settings/targets`       |
| 人设 | `GET persona`、`PUT settings/persona`                                                                         |
| 设置 | `GET settings`、`PUT settings/:block`（monitor/reply/research/tasks/models/dws/advanced）                     |
| 审计 | `GET audit`                                                                                                   |

### 关键交互

- **暂停**：乐观开关 + `POST monitor/pause`，失败回滚并报错。
- **通道状态**：概览从 `health.checks` 的 `channel` 项推导「空闲（未启用目标）/ 已暂停 / 运行中 / 异常 + detail / 未接入」，不误用 `monitor.running`；顶部徽标仍以 `health.status` 为准。
- **页签栏**：不透明 `--dsw-alias-bg-base` 表面保证壁纸下对比度，隐藏滚动条但保留横向滚动；桌面装饰浮层遮挡时可用键盘或概览快捷入口。
- **批准**：弹窗填工作区与备注；工作区留空时由宿主推导 `tasks.workspaceRoot/<taskId>`，非空必须是绝对路径；批准后重拉详情与列表。
- **状态机**：`awaiting-approval` 可批准/拒绝/取消；`queued|running` 可取消；`failed` 可重试；其他状态动作禁用并给出原因。
- **409**：`settings_conflict` 保留草稿、用 `actualRevision` 刷新 revision、自动重拉，可直接重试；状态冲突（如 `alreadyDecided`）重拉详情纠正按钮。
- **400**：`issues[]` 按字段路径定位（去掉 `block.` 前缀），标红、聚焦并提示；消息同时说明问题数。
- **会话**：只读列表 → 详情 → 更早消息（`before` 游标）；`assignment.sessionId` 存在时 `uiWorkspace.openSession`。

## 3. 质量

- **i18n**：所有文案经 `ctx.locale`；zh/en key 集合一致且非空（469）；`src/client/**` 无中文字面量；英文词典无中文。宿主技术详情作为数据原样显示。
- **无障碍**：`tablist/tab/tabpanel` + 方向键/Home/End；焦点环；`role=switch`；弹窗 `role=dialog`、Esc 关闭、焦点进入与归还；`aria-invalid` 与 `role=alert` 字段错误；刷新/暂停/打开会话/加载更多均有 `aria-label`。
- **主题**：只用 `--dsw-alias-*` token；无新图标库；骨架动画尊重 `prefers-reduced-motion`。
- **请求生命周期**：统一 `AbortController` + 15s 超时；`useApi`/`usePaged` 卸载即中止；轮询可配置，只有概览和健康徽标 5s。

## 4. 验证

```text
pnpm install --frozen-lockfile   exit 0（pnpm 11.4.0）
pnpm typecheck                   exit 0
pnpm test                        exit 0；54 files / 649 tests（其中客户端 11 files / 81 tests，新增 77）
pnpm build                       exit 0；client 222.76 kB (gzip 46.31)，index 316.06 kB
pnpm format:check                exit 0
node scripts/check-pack.mjs      exit 0；pack check passed: 15 artifacts, icon 711 bytes
git status --porcelain           提交后为空
```

详细逐项输出与测试覆盖见 [WS6 测试报告](../test-reports/WS6.md)。

## 5. 自评清单

| #   | 检查项                          | 结论 | 证据                                                                                                                     |
| --- | ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| ①   | 七个页签齐全、数据来自真实路由  | 通过 | `app.tsx` + `pages/*`；每个页签只调用 `src/shared/api.ts` 中冻结的路由；测试逐页 mock 真实路径并断言查询参数             |
| ②   | 批准/拒绝/取消/重试与状态机一致 | 通过 | 动作可用性由 `task.status` + `approval.status` + `expiresAt` 推导；测试覆盖待批准、运行中、失败、动作成功/409/字段错误   |
| ③   | 设置 revision 冲突可恢复        | 通过 | 目标/人设/设置三处 409 均保留草稿、刷新 revision、自动重拉并允许重试；测试断言第二次请求使用 `actualRevision`            |
| ④   | 字段注册表驱动、无重复表单      | 通过 | 设置页与人设页都渲染 `fieldsOf(block)`；`RegistryField` 是唯一字段分派；`FIELDS` 无第二份定义                            |
| ⑤   | zh/en 无硬编码                  | 通过 | 469 key 对齐；`client-i18n.spec.ts` 扫描源码 CJK、检查每个 `t()` key 与字段 label/hint                                   |
| ⑥   | 深色对比 / 键盘可用             | 通过 | 仅 token 样式；页签与弹窗键盘测试、Esc 测试；本地深色主题预览人工检查                                                    |
| ⑦   | 轮询不泄漏、卸载取消            | 通过 | `useApi`/`usePaged` 卸载中止；`client-api-layer.spec.tsx` 验证 abort 与轮询停止；仅概览/健康 5s                          |
| ⑧   | 测试覆盖交互而非快照            | 通过 | 77 个新测试均为 DOM 交互与请求断言；无新快照                                                                             |
| ⑨   | 只改 client                     | 通过 | 生产代码仅 `src/client/**`；另更新 `locale/*.json`（产品文案）、`tests/**`、`docs/**`、`package.json`/锁文件（测试依赖） |
| ⑩   | 提交规范、工作区干净            | 通过 | 按 feat/fix/test/docs 拆分；最终 `git status --porcelain` 为空                                                           |

## 6. 提交

```text
353e631 feat(client): api layer and panel shell
e116b66 feat(client): overview and threads
68606f4 feat(client): tasks and approvals
849ee43 feat(client): targets persona and settings
59b05e7 feat(client): audit and i18n
1584657 fix(client): modal focus and accessible field errors
bb47538 test: cover panel tabs, actions, settings and i18n
c876300 fix(client): polish panel layout and copy
8e5118a fix(client): harden paging and health labels
be18753 fix(client): surface the tab bar and idle channel status
a33f413 test: cover tab strip reachability and channel states
+ docs: update the WS6 panel notes
```

## 7. 已知限制与后续

- v1 无收件箱会话、无实时推送；概览/健康轮询 5s，其余手动刷新（详见 [005 §7](../005-panel.md)）。
- review 模式草稿没有面板入口：19 条冻结路由没有决策/发送动作，会话详情只返回收到的消息；面板不做假入口，草稿仍需在钉钉处理。
- 会话视图缺少「是否 @」与决策状态；任务详情缺少派工/结果/会话 ID——宿主模型未提供，面板如实提示，并对可选字段做前向兼容。
- 目标发现/校验在通道未接入时返回 503，面板只解释不伪造。
- 合并到 main 后由维护者在真实 Host 复验并发现两处 P1（页签栏对比度/遮挡、通道状态文案）；本次已修复，最终复验待重载后确认。未做多浏览器视觉回归；本地预览使用 Vite + mock fetch（临时目录，未提交）。
- 本修复提交在 `feat/ws6-panel` 上，未 push；由维护方合并与重载复验。
