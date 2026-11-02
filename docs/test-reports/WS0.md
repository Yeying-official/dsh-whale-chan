# WS0 测试报告

- 日期：2026-11-02（Asia/Shanghai）
- 分支：`feat/ws0-bootstrap`
- 环境：Windows、Node `v24.15.0`、pnpm `11.4.0`、npm `11.12.1`
- 范围：仓库骨架、共享合约、宿主状态、同源头、内存设置/只读人设契约、客户端占位面板、打包检查。
- 审核方真机验证：已安装到 `desktop` profile，侧栏/面板和 `GET state` 均正常；见 [spike §3](../spike-rc5.md)。
- 未执行（实现方）：真实钉钉订阅/发送、`dws event`、bundle 安装、修改 `~/.dsh`。

## 1. 命令与真实输出摘要（Review round 1 后）

| 命令                             | 结果                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | `Already up to date`，exit 0                                           |
| `pnpm typecheck`                 | `tsc --noEmit`，无错误，exit 0                                         |
| `pnpm test`                      | `4` 个测试文件、`35` 个测试全部通过，exit 0                            |
| `pnpm build`                     | 宿主 `lib/index.js` + `lib/index.d.ts`，客户端 `lib/client.js`；exit 0 |
| `node scripts/check-pack.mjs`    | `pack check passed: 10 artifacts, icon 711 bytes`，exit 0              |
| `pnpm format:check`              | `All matched files use Prettier code style!`，exit 0                   |
| `pnpm docs:settings`             | `wrote docs/011-settings-contract.md with 57 fields`，exit 0           |
| `pnpm check`                     | typecheck → test → build 全部通过，exit 0                              |
| `git status --porcelain`         | 提交后复跑输出为空                                                     |

测试明细：

```text
tests/client-api.spec.ts   4 passed
tests/state.spec.ts       12 passed
tests/contract.spec.ts    12 passed
tests/settings.spec.ts     7 passed
Total                     35 passed
```

`pnpm build` 关键输出（Review round 1 后）：

```text
[CJS] lib/client.js  42.04 kB │ gzip: 12.48 kB
[ESM] lib/index.js   18.90 kB │ gzip:  5.93 kB
[ESM] lib/index.d.ts  0.75 kB │ gzip:  0.33 kB
```

## 2. 测试不是空壳

- `contract.spec.ts` 通过遍历 Zod 的 object shape（解开 `ZodDefault`）得到全部叶子路径，与 `FIELDS` 双向比较；不再写死 `57`。
- 默认值逐字段读取并和 `SettingsSchema.parse({})` 比较；快照提交为 `tests/__snapshots__/settings.spec.ts.snap`。
- 数值边界遍历每一个 number 字段，验证 min/max、越界和小数；枚举遍历每个选项。
- i18n 对每个 `labelKey`/`hintKey` 检查中英文字典存在、非空、没有 `TODO/FIXME`，并检查两份字典 key 集合一致。
- API 表检查 19 个端点唯一、方法/路径一致、前缀和 URL 编码；`apiUrl` 的缺参路径有反例。
- 状态测试真正启动 `node:http` 服务，用 `fetch` 请求 200、403、405、404、503；403 验证响应不包含 `stateDir`，OPTIONS 验证无 CORS 允许头。
- 设置路由测试真正发 HTTP：`GET settings` 返回 9 个 block 的 `SettingsView`；缺 revision 为 400；过期 revision 为 409 `settings_conflict`；`PUT persona` 为 405，写入只走 `PUT settings/persona`。
- `client-api.spec.ts` 验证请求 URL 来自 `apiUrl('GET state')`，并检查同源头。
- 分层测试读取源码，验证 core 无 `import`、shared 无 `node:`、client 不导入宿主实现，且 client 不出现 API 路径字面量。
- 打包检查读取真实 `npm pack --dry-run --json` 产物列表，而不是假设 files 白名单生效。

## 3. Spike 结论

详见 [docs/spike-rc5.md](../spike-rc5.md)。摘要：

- `settings.configure({auto:false}, fiber)`、`settings.describe()`、`webServer.register(WebRoute)`、`systemPrompt`、`tools.register`、`workspaceRegistry.create`、`web.search`、`credentials` 均与 rc.5 类型一致。
- 会话创建与投递使用 `agents.create` / `agentLoop.create` 和 `sessionController.prompt({requestId, sessionId, mode, content}, signal)`；WS0 只记录，不实现。
- 客户端用 `ctx.slots.inject` + `ctx.slots.register` 注册 `main` 和 `sidebar.panellist`，`ctx.locale.register` 注册双语字典。
- 真实发现：`WebServer.port` 在 rc.5 变为 `number | undefined`，新增 `getOrigin()`；`WebRuntime` 构造配置变为必填；`dsh-client-ui-slots` 不是客户端插件，不能放入 `dsh.client.inject`。
- 审核方在 `desktop` profile 完成真机安装：`application: applied`、Config 行 schema、客户端 bundle 加载、侧栏「鲸鱼酱」与主面板渲染、`GET state` 200。
- 未找到公开的 `useRemote` 导出；同源状态页使用浏览器 `fetch(apiUrl('GET state'))` 并带同源头。
- 未验证项只剩真实 dws 事件/发送；WS0 未执行。

## 4. 已知缺口

1. 审核方已完成真实页面安装验证；实现方修复同源头后未重新安装 `desktop` profile，header 路径由本地 HTTP 测试覆盖。
2. 没有真实钉钉通道；`dws --version` 为 `v1.0.66`，`dws auth status --format json` 的 `authenticated` 与 `token_valid` 均为 `true`，但没有订阅或发送，也没有把 corpId/userId/token 写入仓库或报告。
3. 设置写入是内存契约探针，没有持久化或设置 UI；重启恢复默认。
4. 管理 API 只实现 state、settings、persona 相关路由；其余端点仅有类型和路由表，返回 404 是可预期的。
5. `prompts/` 尚未创建；pack 白名单已加入，check-pack 有存在时的打包校验分支。
6. 000–009、012、013 中除 010/011 外保持占位，没有编造实现细节。
7. 端点计数：删除 `PUT persona` 后为 19（20 − 1）；审核意见写 18，未再删除已批准端点，等待确认。

## 5. 自评（对照审核清单）

| #   | 审核项                                  | 结论               | 证据                                                                                                                       |
| --- | --------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| ①   | 分层无违反、不重复造 DSH 服务           | 通过               | `src/core` 无 import；`src/app` 只用 DSH 的 webServer/settings；client 不导入宿主层；没有自造事件总线/HTTP 框架/设置服务。 |
| ②   | core 零 I/O                             | 通过               | `src/core/index.ts` 只有 interface/type，无 import、无函数、无环境访问。                                                   |
| ③   | shared 是唯一字段真源且契约测试有效     | 通过               | 57 个 schema 叶子 = 57 个 FieldSpec；测试通过 Zod shape 遍历与默认值读取，非重复常量；魔法数已删除。                       |
| ④   | 仅用实测 API，差异有记录与对策          | 通过               | `docs/spike-rc5.md`；类型路径、live service 目录和 desktop 真机验证；`WebServer.port` 差异已记录。                         |
| ⑤   | client 打包格式正确、不 import 宿主实现 | 通过               | tsdown CJS banner/footer 与 superagent 一致；模拟 loader 与审核方真机安装均通过；共享值从 shared 导入。                    |
| ⑥   | 无密钥/真实数据入库                     | 通过               | 仓库无 token/clientSecret/corpId/userId；dws 报告只记录布尔值。                                                            |
| ⑦   | 失败路径与错误态                        | 通过               | state 405/404/503、同源 403、设置 400/409；面板有离线/服务器错误/无效响应/重试；client-api 测试覆盖网络与坏 JSON。         |
| ⑧   | 文档与字段表同步                        | 通过               | `docs/011` 由 fields 生成；contract 测试逐字段检查文档包含路径；spike/设计/PR/测试报告已写。                               |
| ⑨   | 测试非空壳                              | 通过               | 见 §2；35 个测试覆盖 schema、默认值、边界、i18n、API、分层、真实 HTTP 和 revision 冲突。                                   |
| ⑩   | `git status` 干净、提交信息规范         | 通过（提交后验收） | Review 修复提交按 `fix(contract)` / `test` / `docs` 拆分；提交后复跑 `git status --porcelain` 为空。                       |

## 6. 安全与边界声明

- 未向钉钉发送消息。
- 未创建事件订阅，未执行 `dws event ...`。
- 未修改 `~/.dsh`，未由实现方安装 bundle，未读取 `app.asar`。
- 未提交任何 token、clientSecret、cookie、corpId、userId 或真实消息。
- 参考仓库只读，没有修改。

## 7. Review round 1 修复后复跑输出摘要

- `pnpm typecheck`：exit 0，无错误。
- `pnpm test`：4 files / 35 tests passed；新增 settings revision 与 persona 只读测试。
- `pnpm build`：CJS client 42.04 kB，ESM host 18.90 kB；bundle id 仍为 `dsh-whale-chan-assistant`。
- `node scripts/check-pack.mjs`：`pack check passed: 10 artifacts, icon 711 bytes`；`files` 已包含 `prompts`，因目录当前不存在而不产生额外 artifact。临时创建 `prompts/.pack-check.md` 后复跑为 `11 artifacts`，删除目录后恢复 `10 artifacts`，证明存在时会被打包。
- `pnpm format:check`：通过。
- `pnpm docs:settings`：57 fields；管理 API 段落更新为 19 个端点。
- 端点计数提醒：20 个原端点减去 `PUT persona` 为 19；审核意见中的 18 与删除一个端点的算术不一致，未擅自再删。
