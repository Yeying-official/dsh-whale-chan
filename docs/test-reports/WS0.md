# WS0 测试报告

- 日期：2026-11-02（Asia/Shanghai）
- 分支：`feat/ws0-bootstrap`
- 环境：Windows、Node `v24.15.0`、pnpm `11.4.0`、npm `11.12.1`
- 范围：仓库骨架、共享合约、宿主状态路由、客户端占位面板、打包检查。
- 未执行：真实钉钉订阅/发送、`dws event`、安装 DSH bundle、修改 `~/.dsh`。

## 1. 命令与真实输出摘要

| 命令                             | 结果                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | `Already up to date`，exit 0                                           |
| `pnpm typecheck`                 | `tsc --noEmit`，无错误，exit 0                                         |
| `pnpm test`                      | `4` 个测试文件、`30` 个测试全部通过，exit 0                            |
| `pnpm build`                     | 宿主 `lib/index.js` + `lib/index.d.ts`，客户端 `lib/client.js`；exit 0 |
| `node scripts/check-pack.mjs`    | `pack check passed: 10 artifacts, icon 711 bytes`，exit 0              |
| `pnpm format:check`              | `All matched files use Prettier code style!`，exit 0                   |
| `pnpm docs:settings`             | `wrote docs/011-settings-contract.md with 57 fields`，exit 0           |
| `pnpm check`                     | typecheck → test → build 全部通过，exit 0                              |
| `git status --porcelain`         | 提交后复跑，输出为空（最终验收见会话回复）                             |

测试明细：

```text
tests/client-api.spec.ts   4 passed
tests/state.spec.ts        7 passed
tests/contract.spec.ts    12 passed
tests/settings.spec.ts     7 passed
Total                     30 passed
```

`pnpm build` 关键输出：

```text
[CJS] lib/client.js  39.68 kB │ gzip: 11.89 kB
[ESM] lib/index.js    5.81 kB │ gzip: 2.53 kB
[ESM] lib/index.d.ts  0.78 kB │ gzip: 0.35 kB
```

## 2. 测试不是空壳

- `contract.spec.ts` 通过遍历 Zod 的 object shape（解开 `ZodDefault`）得到全部叶子路径，与 `FIELDS` 双向比较；不是复制一份常量。
- 默认值逐字段读取并和 `SettingsSchema.parse({})` 比较；快照文件提交为 `tests/__snapshots__/settings.spec.ts.snap`。
- 数值边界遍历每一个 number 字段，验证 min/max、越界和小数；枚举遍历每个选项。
- i18n 对每个 `labelKey`/`hintKey` 检查中英文字典存在、非空、没有 `TODO/FIXME`，并检查两份字典 key 集合一致。
- API 表检查 20 个端点唯一、方法/路径一致、前缀和 URL 编码；`apiUrl` 的缺参路径有反例。
- 状态测试真正启动 `node:http` 服务，用 `fetch` 请求成功、405、404、503 四种情况；503 通过“把 stateDir 指向一个文件”制造真实启动失败。
- 分层测试读取源码，验证 core 没有 `import`、shared 没有 `node:`、client 不导入宿主实现。
- 打包检查读取真实 `npm pack --dry-run --json` 产物列表，而不是假设 files 白名单生效。

## 3. Spike 结论

详见 [docs/spike-rc5.md](../spike-rc5.md)。摘要：

- `settings.configure({auto:false}, fiber)`、`settings.describe()`、`webServer.register(WebRoute)`、`systemPrompt`、`tools.register`、`workspaceRegistry.create`、`web.search`、`credentials` 均与 rc.5 类型一致。
- 会话创建与投递使用 `agents.create` / `agentLoop.create` 和 `sessionController.prompt({requestId, sessionId, mode, content}, signal)`；WS0 只记录，不实现。
- 客户端用 `ctx.slots.inject` + `ctx.slots.register` 注册 `main` 和 `sidebar.panellist`，`ctx.locale.register` 注册双语字典。
- 真实发现：`WebServer.port` 在 rc.5 变为 `number | undefined`，新增 `getOrigin()`；`WebRuntime` 构造配置变为必填；`dsh-client-ui-slots` 不是客户端插件，不能放入 `dsh.client.inject`。
- 客户端 bundle 已用模拟 `window.__ModuleLoader__` 执行：id 为 `dsh-whale-chan-assistant`，工厂返回 `inject`/`apply`。
- 未找到公开的 `useRemote` 导出；同源状态页使用浏览器相对 `fetch`，符合 WS0 需求。

## 4. 已知缺口

1. 没有安装到 DSH profile，因此未在真实页面中看到侧栏图标、主面板或请求；需要用隔离 profile 做一次人工验收。
2. 没有真实钉钉通道；`dws --version` 为 `v1.0.66`，`dws auth status --format json` 的 `authenticated` 与 `token_valid` 均为 `true`，但没有订阅或发送，也没有把 corpId/userId/token 写入仓库或报告。
3. 设置只冻结 schema 和字段表，没有持久化、设置读取/写入实现或设置 UI。
4. 管理 API 只实现 `GET state`；其余端点仅有类型和路由表，路由返回 404 是可预期的。
5. 000–009、012 文档按 WS0 要求保持占位，没有编造实现细节。
6. 面板只做状态概览；没有目标列表、任务、审批或审计视图。

## 5. 自评（对照审核清单）

| #   | 审核项                                  | 结论                     | 证据                                                                                                                       |
| --- | --------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| ①   | 分层无违反、不重复造 DSH 服务           | 通过                     | `src/core` 无 import；`src/app` 只用 DSH 的 webServer/settings；client 不导入宿主层；没有自造事件总线/HTTP 框架/设置服务。 |
| ②   | core 零 I/O                             | 通过                     | `src/core/index.ts` 只有 interface/type，无 import、无函数、无环境访问。                                                   |
| ③   | shared 是唯一字段真源且契约测试有效     | 通过                     | 57 个 schema 叶子 = 57 个 FieldSpec；测试通过 Zod shape 遍历与默认值读取，非重复常量。                                     |
| ④   | 仅用实测 API，差异有记录与对策          | 通过                     | `docs/spike-rc5.md`；类型路径与 live service 目录双重证据；`WebServer.port` 差异已记录。                                   |
| ⑤   | client 打包格式正确、不 import 宿主实现 | 基本通过（真实页面待验） | tsdown CJS banner/footer 与 superagent 一致；模拟 loader 通过；未安装 profile，真实挂载未验。                              |
| ⑥   | 无密钥/真实数据入库                     | 通过                     | 仓库无 token/clientSecret/corpId/userId；dws 报告只记录布尔值。                                                            |
| ⑦   | 失败路径与错误态                        | 通过                     | state 路由 405/404/503；面板有离线、服务器错误、无效响应和重试；client-api 测试覆盖网络失败/HTTP 失败/坏 JSON。            |
| ⑧   | 文档与字段表同步                        | 通过                     | `docs/011` 由 fields 生成；contract 测试逐字段检查文档包含路径；spike/设计/PR/测试报告已写。                               |
| ⑨   | 测试非空壳                              | 通过                     | 见 §2；30 个测试覆盖 schema、默认值、边界、i18n、API、分层、真实 HTTP。                                                    |
| ⑩   | `git status` 干净、提交信息规范         | 通过（提交后验收）       | 计划 5 个 Conventional Commits；提交后复跑 `git status --porcelain` 为空。                                                 |

## 6. 安全与边界声明

- 未向钉钉发送消息。
- 未创建事件订阅，未执行 `dws event ...`。
- 未修改 `~/.dsh`，未安装 bundle，未读取 `app.asar`。
- 未提交任何 token、clientSecret、cookie、corpId、userId 或真实消息。
- 参考仓库只读，没有修改。
