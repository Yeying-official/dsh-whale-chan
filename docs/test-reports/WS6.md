# WS6 测试报告

- 日期：2026-11-03（Asia/Shanghai）
- 分支：`feat/ws6-panel`（worktree `E:\DSHWork\wt-ws6`）
- 环境：Windows、Node `v24.15.0`、pnpm `11.4.0`、vitest `4.1.8`、jsdom `29.1.1`、React `18.3.1`
- 范围：客户端 API 层、七页签面板、审批/设置/目标/人设交互、i18n、无障碍；宿主与共享层未修改。

## 1. 门禁命令与真实输出

| 命令                             | 结果                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0；`Done in 43.7s`（之后加测试库用 `pnpm add -D` 更新锁文件）                                                      |
| `pnpm typecheck`                 | `tsc --noEmit`，无输出，exit 0                                                                                          |
| `pnpm test`                      | `Test Files 54 passed (54)`、`Tests 649 passed (649)`，exit 0                                                           |
| `pnpm build`                     | `lib/client.js 222.76 kB │ gzip: 46.31 kB`；`lib/index.js 316.06 kB │ gzip: 87.45 kB`；`lib/index.d.ts 0.90 kB`，exit 0 |
| `pnpm format:check`              | `All matched files use Prettier code style!`，exit 0                                                                    |
| `node scripts/check-pack.mjs`    | `pack check passed: 15 artifacts, icon 711 bytes`，exit 0                                                               |
| `git status --porcelain`         | docs 提交后为空                                                                                                         |

客户端测试汇总（`tests/client-*.spec.*`）：

```text
tests/client-api.spec.ts        4 passed   （既有，保留）
tests/client-api-layer.spec.tsx 8 passed
tests/client-shell.spec.tsx     7 passed
tests/client-overview.spec.tsx 10 passed
tests/client-threads.spec.tsx   5 passed
tests/client-tasks.spec.tsx    12 passed
tests/client-targets.spec.tsx   7 passed
tests/client-settings.spec.tsx 10 passed
tests/client-persona.spec.tsx   7 passed
tests/client-audit.spec.tsx     4 passed
tests/client-i18n.spec.ts       7 passed
----------------------------------------
11 files / 81 tests（WS6 新增 77）
```

## 2. 测试设计

- **真实面板，不测孤立组件**：`tests/client-harness.tsx` 渲染真实 `PanelProvider + App`，只 mock 全局 `fetch`；页面、请求层、错误映射、路由参数都走生产代码。
- **不发真实请求**：`installFetch` 按 `method + path`（含 query）返回内存对象；每个测试只实现自己关心的路由，其余返回 404。请求体通过 `requestBodies/requestCount` 断言。
- **jsdom 按文件指定**：每个 DOM 测试文件首行 `// @vitest-environment jsdom`，未修改 `vitest.config.ts` 的全局 `environment: 'node'`。
- **无快照**：全部断言 DOM、请求次数/请求体、localStorage/hash、焦点与错误文案；不新增 `tests/__snapshots__`。
- **清理**：`resetPanelTest()` 统一 `cleanup`、卸载全局 stub、清 localStorage、恢复 URL 与 body，避免跨文件污染。

### 各文件覆盖

| 文件                        | 覆盖                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client-api-layer.spec.tsx` | 三个动词带 `x-whale-chan-request`、JSON content-type；`ErrorBody` 的 code/issues/actualRevision；`ApiError.conflict`；离线与非法 JSON；15s 超时（fake timers）；typed query 编码；`useApi` 卸载 abort、轮询启动/停止；`useMutation` 成功/失败/reset                                                                                                |
| `client-shell.spec.tsx`     | 七个页签；点击写入 localStorage 与 `#hash`；hash 优先于持久化；无 hash 回退持久化；方向键/Home/End；健康徽标正常与 503 状态；刷新触发健康重拉                                                                                                                                                                                                      |
| `client-overview.spec.tsx`  | 四个计数、最近活动、健康检查；暂停 POST 与成功后重拉；暂停失败回滚开关并报错；快捷入口切换页签；概览 500 → 重试恢复                                                                                                                                                                                                                                |
| `client-threads.spec.tsx`   | 列表 → 详情 → 返回；`before` 游标加载更早消息；空态；加载错误重试；只读限制说明                                                                                                                                                                                                                                                                    |
| `client-tasks.spec.tsx`     | 状态筛选 query；详情简报/审批/来源消息/执行不可用提示；批准弹窗工作区校验（相对路径拦截、不发请求）；批准提交 `{approvalId,workspace,note}` 并重拉；409 `alreadyDecided` 报错并重拉；失败任务可重试、批准/拒绝禁用；运行中可取消并提交理由；`assignment.sessionId` 触发 `openSession`；无会话 ID 提示；Esc 关闭弹窗；键盘 Tab+Enter 完成批准；空态 |
| `client-targets.spec.tsx`   | 行编辑保存（`mentionOnly` 修改 + revision）；409 保留草稿并用 `actualRevision` 重试；发现候选 → 添加 → 保存两行；校验结果摘要与逐行错误；发现 503 `channel_unavailable`；删除行保存空数组；空态                                                                                                                                                    |
| `client-settings.spec.tsx`  | block 切换与注册表字段渲染；数字编辑保存（revision）；布尔保存；string-list 增加并保存；400 issues 定位字段并 `aria-invalid`；409 冲突后第二次保存用新 revision；危险项说明（paused/dryRun）；读失败重试；切 block 保留脏状态；键盘保存                                                                                                            |
| `client-persona.spec.tsx`   | 名字编辑驱动本地预览；语气与字数预览；保存 revision 与 name；空名字本地拦截；超字数提示；409 冲突与新 revision 重试；读失败重试                                                                                                                                                                                                                    |
| `client-audit.spec.tsx`     | 行渲染与加载更多（offset 分页、按钮消失）；空态；加载失败重试；denied 结果本地化                                                                                                                                                                                                                                                                   |
| `client-i18n.spec.ts`       | zh/en key 集合一致且非空；页签/状态/审批/目标类型/回复模式/健康检查/设置 block 文案齐全；字段 label/hint 齐全；源码中所有字面量 `t()` key 存在；`src/client/**` 无 CJK；英文词典无中文；无 TODO/FIXME/TBD                                                                                                                                          |

## 3. 手工视觉检查

为确认布局与深色主题（自动化测试只验证行为），用临时 Vite 工程把真实 `App` 挂到 `http://127.0.0.1:59987`，用同一套 mock 路由提供数据，在 Chromium（1280×800，深色 token）中逐页检查：

- 概览：两栏布局、计数/健康/最近活动/快捷入口；
- 任务：列表 → 详情 → 批准弹窗（工作区提示来自 `tasks.workspaceRoot`，备注、取消/确认布局）；
- 目标：目标表全宽 + 发现/校验两栏；
- 人设：表单 + 实时预览；
- 设置：block 导航、数字单位内联、危险项说明；
- 审计：时间/类型/摘要/结果表；
- 会话：列表与消息详情。

检查后修正了三处布局/文案问题（概览执行通道重复、目标表过窄、数字单位换行），临时目录与静态服务已删除，未提交任何预览产物。

## 4. 合并后的 P1 修复

维护者在真实 Host 上复验 WS6（main `28d5645`）时发现两处 UI 问题，已在本次补齐：

1. **页签栏对比度与遮挡**：页签栏透明，壁纸亮部降低文字对比度；桌面装饰浮层还遮住最右侧「审计」页签的点击区域。修复：`.wc-tabs` 使用不透明 `--dsw-alias-bg-base` 表面；`overflow-x:auto` 保留、`scrollbar-width:none` 与 `::-webkit-scrollbar{display:none}` 隐藏滚动条；`scroll-margin-inline`/`scroll-padding-inline` 保证焦点与激活态不被裁切。外部装饰浮层不归插件控制，已知限制与操作提示写入 005。
2. **通道状态文案错误**：概览原先用 `overview.monitor.running` 显示「执行通道未接入」，但真实状态是已授权 + 0 启用目标 + idle。修复：改为读取 `health.checks` 的 `channel` 项，映射 `idle`/`paused by the owner`/`ready`/`error`（附 detail）/`monitoring is disabled`/`degraded`/无检查项；顶部健康徽标仍只看 `health.status`。

新增 6 个测试：页签条 7 个页签全部键盘可达且唯一 roving tabIndex、样式块包含不透明底/横向滚动/隐藏滚动条；通道 idle、paused、ready、error、absent 五条映射。写完后全仓 54 files / 649 tests 通过。

## 5. 未覆盖 / 已知缺口

- **真实 Host 端到端**：没有把插件安装到 profile，也没有对真实 `state.db`、dws 通道或 DSH 会话目录运行；`openSession` 仅在 mock 的会话目录服务上验证调用参数。
- **通道相关**：WS5a 的 `targets/discover|validate` 在通道未接入时固定 503，测试覆盖 503 文案，未覆盖真实发现结果。
- **视觉回归**：无截图基线；只做一次性人工检查，未覆盖多浏览器/缩放比例。
- **响应式**：CSS 断点（900/640）按设计实现并在宽屏检查；未在真实 DSH 侧栏宽度下逐档截图。
- **任务详情缺失字段**：宿主 `TaskDetail` 不含派工/结果/会话 ID；面板按可选字段前向兼容并给出明确提示，测试用注入 `assignment.sessionId` 验证打开逻辑。
- **轮询精度**：概览/健康 5s；未做网络抖动或长离线的长时间浸泡测试。

## 6. 结论

WS6 的客户端实现通过全部静态门禁、649 个全仓测试（其中客户端 81 个、新增 77 个）与打包检查；交互（含键盘与 409 恢复）、i18n、页签可达性与通道状态映射均有行为测试。合并到 main 后维护者在真实 Host 复验发现的两处 P1 已修复，待重载复验；剩余缺口集中在多浏览器视觉回归。
