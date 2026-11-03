# WS12 人设默认与预设验收报告

- 日期：2026-11-03（Asia/Shanghai）
- 分支：`feat/ws13-release-0.3.0`（记录提交；WS12 实现已在 `main` `a733193`，实现提交 `be013d7`）
- 环境：Windows 10/11 x64、Node v24.15.0、DSH Desktop `0.2.1-rc.5`、profile `desktop`、`dws` v1.0.66（个人 OAuth）
- 账号：企业账号（本文不记录 corpId / userId / token / 完整群 id 与真实群名）
- 范围：空人设默认值、蓝白鲸鱼女仆可选预设、人设页两个草稿动作（恢复默认 / 载入预设）
- 关联：[012 发布](../012-release.md)、[014 人设默认值与预设](../014-persona-defaults.md)、[013 安全基线](../013-security.md)、[WS8 真机](WS8-live.md)、[WS9/WS10 真机](WS9-10.md)

## 0. 结论

| 项                             | 结果               | 证据                                                                                                               |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 默认人设（重载后）             | 通过               | `GET /whale-chan/api/persona` 的 `persona` 与 `defaults` 均为空人设：仅 `name=鲸鱼酱`，其余字段空，`language=auto` |
| 预设投影                       | 通过               | 同一响应的 `presets` 含 `whale-maid`（蓝白鲸鱼女仆）；`zh-CN`、6 条规则、非空 `identity`                           |
| 页面「恢复默认（空人设）」     | 通过（组件测试）   | 草稿被清空为 `defaults` 并置 dirty；不发 `PUT`，保存按钮点击后才写入                                               |
| 页面「载入预设：蓝白鲸鱼女仆」 | 通过（组件测试）   | 草稿被填满 `presets[0].persona`；只在点保存时发 `PUT`                                                              |
| 已保存自定义人设               | 通过               | 不自动套模板、不被覆盖；旧 persona 行原样保留                                                                      |
| 旧 host 兼容                   | 通过（组件测试）   | host 不返回 `defaults`/`presets` 时两个按钮整块隐藏，页面行为与升级前一致                                          |
| 显示名与内部标识               | 通过               | 侧栏/面板仍显示「DSH助理」；包名、状态目录、API 前缀与 panel/session/preset id 不变                                |
| 回归门禁                       | 通过               | `pnpm check` 765 tests / 60 files；`node scripts/check-pack.mjs` 15 artifacts，icon 711 bytes                      |
| 测试目标                       | 已停用（保留目标） | 测试群目标 `enabled=false`（保留该行与工作区），通道 `idle: no enabled targets`                                    |

## 1. 范围与实现

WS12 把「默认人设是一个角色」拆成两件事：

- **空默认**：`src/shared/persona-defaults.ts#EMPTY_PERSONA` 只保留 `name = 鲸鱼酱`；`identity`、`tone`、`signature`、`knowledge` 为空字符串，`rules`、`samples` 为空数组，`language = auto`。`PersonaSchema` 的每个默认值、`fields.ts` 的 `defaultValue` 都指向它。
- **可选预设**：同一文件的 `WHALE_MAID_PERSONA` / `PERSONA_PRESETS` 提供 `whale-maid`（蓝白鲸鱼女仆），默认不启用，只在 `GET persona` 的只读投影里出现。
- **面板两个动作**：人设页在保存按钮上方提供「恢复默认（空人设）」与「载入预设：蓝白鲸鱼女仆」；两者只改本地草稿、置 dirty、清字段错误并提示“保存后生效”，**不会自动保存**。

设计、来源、原创与非官方声明、排除项与升级行为见 [014](../014-persona-defaults.md)，本报告不重复结论。

## 2. 真机核对

前置：沿用已安装的 `link:` 版本，不改 profile；测试群目标保持 `enabled=false`（保留该行与工作区）。

1. 重载 DSH 后打开面板，侧栏与插件列表仍显示「DSH助理」，面板版本随 `0.3.0` 发布提交更新（本报告记录的是人设行为，不把版本号当作验收对象）。
2. 带 `x-whale-chan-request: 1` 读取 `GET /whale-chan/api/persona`：
   - `persona`：仅 `name=鲸鱼酱`；`identity`/`tone`/`signature`/`knowledge` 为空，`rules`/`samples` 为空数组，`language=auto`；
   - `defaults`：与 `persona` 相同的空人设；
   - `presets`：包含 `id=whale-maid`，`language=zh-CN`、6 条规则、非空 `identity`；与 `defaults` 不相等。
3. 打开「人设」页：两个动作可见；页面没有因预设存在而自动改变草稿或自动保存。
4. 确认测试群目标为 `enabled=false`（保留该行与工作区），通道 `idle: no enabled targets`；本轮没有新增真机群消息。

说明：本轮**未做浏览器截图**，页面可见行为由组件测试覆盖；也**没有新增真机群回复**，因为 WS12 不涉及分类、发送、任务执行或回帖链路。

## 3. 页面组件测试

`tests/client-persona.spec.tsx`（jsdom + Testing Library）覆盖：

| 用例                                                                     | 断言                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `renders the empty default persona on a fresh installation`              | 全新安装渲染空默认：名字「鲸鱼酱」，身份/语气/签名/规则/知识/示例为空，语言 `auto`          |
| `restores the empty default persona into the draft without saving`       | 点「恢复默认」后草稿等于 `defaults`、置 dirty；请求记录中没有 `PUT settings/persona`        |
| `loads the whale maid preset into the draft and saves it only on demand` | 点「载入预设」后草稿等于 `presets[0].persona`；未点保存前无 `PUT`，点保存后才发出一次 `PUT` |
| `keeps a saved custom persona instead of applying a template`            | 已保存的自定义值原样呈现；载入预设/恢复默认不会自动覆盖已保存值                             |
| `hides the default and preset actions on a host that does not send them` | host 响应缺少 `defaults`/`presets` 时两个按钮整块隐藏，其余表单行为不变                     |

配套 `tests/client-harness.tsx` 在 mock host 中增加 `defaults`/`presets`，并提供去掉这两个字段的 legacy 变体。

## 4. 接口、schema 与存储测试

- `tests/api-routes.spec.ts`：`GET persona` 返回 `{ persona, revision, defaults, presets }`；`defaults` 深度等于 `EMPTY_PERSONA`，`presets` 的 id 只有 `whale-maid`，预设与默认值不相等。
- `tests/settings-service.spec.ts`：默认值来自冻结常量且 revision 为 0；每次读取返回深拷贝，调用方修改 `defaults`/`presets` 不会污染下一次读取或常量本身。
- `tests/settings.spec.ts`：schema 默认值等于 `EMPTY_PERSONA`；字段表逐项镜像；数组默认值为工厂，两次解析不共享引用；`whale-maid` 元数据（名称、语言、6 条规则）正确且与默认值不同。
- 存储：`settings.persona` 仍是唯一来源，预设不落库；`state.db` schema 仍为 2。

## 5. 回归与门禁

- `pnpm check`：typecheck 0 错误，**765 tests / 60 files**，build 成功（宿主 ESM + 客户端 CJS）。
- `pnpm format:check` 通过。
- `node scripts/check-pack.mjs` → `15 artifacts`，icon 711 bytes（本版未增删打包文件）。
- 验收后测试群目标保持 `enabled=false`（保留该行与工作区）；测试期间未产生临时文件，未入库。

## 6. 未覆盖与说明

- **已保存的旧 persona 不自动迁移**：升级只影响从未保存过人设（块缺失）的安装；旧行原样保留，需要空人设时手动「恢复默认」并保存。
- **预设是非官方二创**：「鲸鱼酱」是本地二创形象，预设正文明确声明非 DeepSeek 官方角色、未获官方授权；来源与排除项见 [014](../014-persona-defaults.md)。
- **预设只读**：不点保存不会生效；预设的 `zh-CN` 不改变默认的 `auto`。
- **旧 host 兼容**：旧 host 忽略新增字段，旧 panel 照常读写 persona；按钮隐藏逻辑只影响新面板。
- **未重跑 T3/T4**：本轮不涉及回复/发送/任务链路，沿用 [WS8](WS8-live.md) 与 [WS9/WS10](WS9-10.md) 的真机结论。
- 真机只使用内部测试群；报告不记录 corpId、userId、token、完整群 id 与真实群名。
