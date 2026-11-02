# 鲸鱼酱 · 钉钉助理

> 当前状态：**WS0 开发中**。仓库只包含 Cordis 插件骨架、冻结的前后端合约和宿主状态接口；没有接入真实钉钉，不会读取、发送或订阅任何消息。

`dsh-whale-chan-assistant` 是 DeepSeek Harness 的 Cordis bundle。目标形态是：通过本机 `dws` 的**个人授权**通道读取当前用户可见的钉钉消息，在控制频率与隐私的前提下回复、检索或捕获任务，并让人在 DSH Web 面板中批准任务。

## 当前能做什么

- 注册 `whale-chan` 主面板和侧栏入口。
- 挂载 `GET /whale-chan/api/state`，显示宿主版本、状态目录与启动时间。
- 冻结设置/人设 API，并提供同源头校验的 `GET settings`、内存态 `PUT settings/:block` 与只读 `GET persona`。
- 冻结完整的设置 schema、字段表、19 个管理 API 端点与中英文文案。
- 通过契约测试证明 schema、field registry、API 路由和 i18n 一一对应。
- 在状态目录无法创建时返回结构化 503，面板显示可重试的离线/错误态。

## 暂不做什么

- 不启动 `dws`，不创建钉钉事件订阅，不发送钉钉消息。
- 不实现任务、审批、检索、执行器或持久化；设置写入只是 WS0 的内存契约探针。
- 不安装到任何 DSH profile，也不修改 `~/.dsh`。

## 安装

本仓库当前是开发中包，不自动安装到 DSH。后续打包后由 DSH 的 **plugin_manager** 安装 bundle；`cordis.patch.yml` 只声明宿主插件行，WS4 才会加入 `dsh-whale-chan-replier` / `dsh-whale-chan-worker` 两个 agent preset。安装说明会随 WS4/WS5 更新。

本地检查：

```bash
pnpm install
pnpm check
node scripts/check-pack.mjs
```

## 命令

| 命令                 | 说明                                             |
| -------------------- | ------------------------------------------------ |
| `pnpm install`       | 安装锁定版本依赖（DSH 包使用 `0.2.1-rc.5`）      |
| `pnpm typecheck`     | 运行 `tsc --noEmit`                              |
| `pnpm test`          | 运行 Vitest 契约、设置与状态测试                 |
| `pnpm build`         | 由 tsdown 生成宿主 ESM 与客户端 CJS 包           |
| `pnpm check`         | 依次运行 typecheck、test、build                  |
| `pnpm pack:check`    | 校验 manifest、图标、files 与打包内容            |
| `pnpm docs:settings` | 从字段表重新生成 `docs/011-settings-contract.md` |
| `pnpm format:check`  | 检查 Prettier 格式                               |

## 目录

| 路径          | 作用                                                              |
| ------------- | ----------------------------------------------------------------- |
| `src/shared/` | 设置 schema、字段表、API 合约、视图模型和边界常量；前后端唯一真源 |
| `src/core/`   | 纯领域类型骨架，零 I/O，不 import 其他层                          |
| `src/app/`    | Runtime、部署配置、HTTP 路由、内存设置契约与视图                  |
| `src/client/` | `whale-chan` 面板、状态轮询和本地 UI 原语                         |
| `locale/`     | 面板文案与全部设置字段 label/hint                                 |
| `docs/`       | 设计、设置合约、spike 与交付证据                                  |
| `tests/`      | 契约、设置默认值/边界、状态与设置路由集成测试                     |

## 文档索引

- [009 DWS 协议](docs/009-dws-protocol.md)（占位，WS2 实测）
- [010 设计摘要](docs/010-design.md)
- [011 设置合约](docs/011-settings-contract.md)
- [013 安全](docs/013-security.md)（占位，WS2 评审）
- [rc.5 API spike](docs/spike-rc5.md)
- [WS0 测试报告](docs/test-reports/WS0.md)

## 宿主配置

`cordis.patch.yml` 不携带 config。若要在开发环境中覆盖状态目录，可在宿主 profile 中为条目添加：

```yaml
- id: dsh-whale-chan-assistant
  name: dsh-whale-chan-assistant
  config:
    stateDir: ~/.dsh-whale-chan
    logLevel: info
```

默认状态目录是 `~/.dsh-whale-chan`。

## 安全边界

- 不提交 token、clientSecret、cookie 或真实消息。
- 个人授权只在本机使用；WS0 不读取凭证。
- 面板状态只读；设置写入已有 `x-whale-chan-request` 同源守卫，但持久化和完整授权仍留到 WS4。
- 任何真机发送都必须先经过测试群 `AI工程师孵化中心` 的 T0–T3 护栏。

## 许可证

MIT，见 [LICENSE](LICENSE)。
