# dsh-web-search

同时兼容 **DSH** 与 **Pi** 的网页搜索 / 网页抓取插件，一个仓库、一份内核、两套宿主适配。

| 能力 | DSH | Pi |
| --- | --- | --- |
| 搜索 | 向 `ctx.web` 注册提供方 `free-first` | 注册模型工具 `web_search` |
| 抓取 | 向 `ctx.web` 注册提供方 `local-first` | 注册模型工具 `web_fetch` |
| 密钥菜单 | —（配置来自 Cordis 配置） | `/web-search-auth` 命令 |

匿名顺序为 **Exa → Tavily → Parallel → Firecrawl → TinyFish（keyless）**；计费顺序为 **Exa → Tavily → Parallel → Firecrawl → SerpApi**。默认禁止计费，只有显式授权且在匿名通道全部失败后才会尝试密钥通道。TinyFish 只有零凭据匿名通道。

## 结构

```text
src/
├── search/     # 搜索内核：路由、协议、MCP 解析、脱敏、正文落盘
├── quota/      # 额度预检、冷却状态、私有持久化
├── auth/       # 凭据解析与系统密钥库（macOS Keychain / Linux secret-tool）
├── fetch/      # 抓取内核：SSRF 校验、有界响应、HTML→Markdown
├── shared/     # 两个内核共用的有界响应体读取
├── compat/     # DSH 0.1.x 的额度/状态接口兼容层
└── hosts/
    ├── dsh.ts      # Cordis 插件：注册搜索与抓取提供方
    ├── pi.ts       # Pi：web_search 工具 + /web-search-auth
    └── pi-fetch.ts # Pi：web_fetch 工具
```

内核不 import 任何宿主 API，因此两个宿主共用同一套路由、额度、冷却与脱敏行为，也可以离线测试。

## 安装

### DSH

```bash
dsh plugin --profile <profile> add link:<server_path>/dsh-web-search
```

`cordis.patch.yml` 会同时启用 `free-first`（搜索）与 `local-first`（抓取）。抓取提供方使用独立 id，因为官方插件已占用 `http`；若你已有自定义 `fetchProvider`，请保留你的选择。

### Pi

```bash
pi install <server_path>/dsh-web-search
```

或在 `settings.json` 中按目录启用：

```json
{
  "packages": [
    { "source": "git:github.com/Luca4Don3/dsh-web-search", "extensions": ["pi.ts"] }
  ]
}
```

安装后可用 `/web-search-auth` 管理密钥。环境变量优先于系统密钥库。

## 配置

### DSH（Cordis 配置）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `allowBillable` | `false` | 显式授权可能计费的通道 |
| `timeoutMs` | `25000` | 单请求预算，毫秒 |
| `totalTimeoutMs` | `90000` | 整次调用总预算，毫秒 |
| `maxResponseBytes` | `5242880` | 解压后响应体上限 |
| `maxChars` | `24000` | 模型可见正文字符预算 |
| `retries` | `1` | 网络或服务端错误重试次数 |
| `cooldownOverrideMs` | 未设置 | 冷却覆盖，`0` 禁用冷却 |
| `stateDirectory` | `$DSH_HOME/config/web-search` | 冷却状态目录 |
| `fetchTimeoutMs` | `20000` | 抓取总预算，毫秒 |
| `fetchMaxResponseBytes` | `5242880` | 抓取解压后响应体上限 |
| `fetchMaxChars` | `24000` | 抓取正文上限 |
| `fetchMaxRedirects` | `3` | 最大跳转次数 |

### Pi（环境变量）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_WEB_SEARCH_ALLOW_BILLABLE` | `false` | 同 `allowBillable`，只接受 `true` / `false` |
| `PI_WEB_SEARCH_ALLOW_PAID` | 未设置 | 旧开关别名，与上一项冲突时报错 |
| `PI_WEB_SEARCH_ROUTING` | `free-first` | 路由策略；与计费授权同时为 `key-first` 时报错 |
| `PI_WEB_SEARCH_TIMEOUT_MS` | `25000` | 单请求预算 |
| `PI_WEB_SEARCH_TOTAL_TIMEOUT_MS` | `90000` | 整次调用预算 |
| `PI_WEB_SEARCH_MAX_RESPONSE_BYTES` | `5242880` | 响应体上限 |
| `PI_WEB_SEARCH_RETRIES` | `1` | 重试次数，`0..3` |
| `PI_WEB_SEARCH_FREE_COOLDOWN_MS` | 未设置 | 固定冷却覆盖 |
| `PI_WEB_FETCH_TIMEOUT_MS` | `20000` | 抓取总预算 |
| `PI_WEB_FETCH_MAX_RESPONSE_BYTES` | `5242880` | 抓取响应体上限 |
| `PI_WEB_FETCH_MAX_CHARS` | `24000` | 抓取正文上限 |
| `PI_WEB_FETCH_MAX_REDIRECTS` | `3` | 最大跳转次数 |

密钥：`EXA_API_KEY`、`TAVILY_API_KEY`、`PARALLEL_API_KEY`、`FIRECRAWL_API_KEY`、`SERPAPI_API_KEY`。TinyFish 始终 keyless，不读取 `TINYFISH_API_KEY`。

## 安全与限制

- 未授权计费时不读取任何服务商密钥、凭据库或额度接口。
- 授权后一次性解析全部所需密钥，并在正文、来源、details 与落盘内容中统一脱敏。
- 只能通过环境变量或系统密钥库注入密钥；不提供明文文件回退。
- 响应体按解压后字节计数上限，超限立即中止请求，不返回部分结果。
- 冷却状态只保存 HMAC 作用域与冷却元数据，目录 `0700`、文件 `0600`。
- 额度预检只回答「当前是否付得起」，不能证明账户免费，也不提供跨进程账单硬上限。
- 抓取拒绝私有段、回环、链路本地与云元数据地址，不执行网页脚本，不携带 Cookie。
- 两个宿主的单元测试全部离线；这不等于真实桌面安装、真实密钥库写入或服务商网络验收。

## 开发验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check          # 严格类型检查
npm test               # DSH 兼容层 + Pi + 抓取全部离线用例
npm run check:artifacts
npm pack --dry-run
```

Pi 用例通过 `jiti` 直接加载 `src/` 下的源码，因此需要本机装有 Pi（提供 `jiti` 与 `typebox`）。CI 会先安装 `@earendil-works/pi-coding-agent` 再运行。

`npm run smoke` 是手动匿名网络检查，不进入持续集成，不使用密钥或计费通道。

## License

MIT
