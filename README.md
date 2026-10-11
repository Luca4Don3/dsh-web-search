# DSH 搜索插件

`dsh-web-search@0.1.1`：匿名优先的独立搜索插件，兼容目标为 `DSH 0.2.0-rc.2`，需要 `Node.js >=24`。

注册聚合提供方 `free-first`，使用官方 `web_search`，不替换模型工具或 `web_fetch`。

## 功能

- 匿名顺序：Exa → Tavily → Parallel → Firecrawl → TinyFish，成功即返回。
- 默认禁止计费通道；只有明确授权且匿名通道全部失败后，才尝试密钥搜索。
- 支持整体超时、取消、响应大小限制、结果脱敏和冷却恢复。
- 不保存查询、响应正文、密钥、账号标识或原始错误。

## 安装

仓库：[Luca4Don3/dsh-web-search](https://github.com/Luca4Don3/dsh-web-search)。已包含编译入口，不依赖安装脚本构建。

本地目录链接命令：

```bash
dsh plugin --profile <profile> add link:<server_path>/dsh-web-search
```

替换配置档名和项目父目录路径；桌面配置档通常为 `desktop`。该命令尚未完成真实桌面安装验收，项目不会自动修改你的安装或设置。

**补丁影响：** `cordis.patch.yml` 选择 `free-first` 搜索和 `http` 抓取。补丁会替换整行网页配置，已有自定义抓取或其他字段须手动保留在高优先级补丁中。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `allowBillable` | `false` | 可信配置显式授权可能计费的通道 |
| `timeoutMs` | `25000` | 整次搜索期限，毫秒 |
| `maxResponseBytes` | `5242880` | 解压后响应字节上限 |
| `maxChars` | `24000` | 正文与来源字段总字符预算 |
| `retries` | `1` | 网络或服务端错误重试，不重试 429 |
| `cooldownOverrideMs` | 未设置 | 冷却覆盖，`0` 禁用冷却 |
| `stateDirectory` | 自动计算 | 默认 `$DSH_HOME/config/web-search` |

`DSH_HOME` 为空时使用 `~/.dsh`。工具只接收 `query` 和可选 `maxResults`（默认 `8`，范围 `1..20`），不能通过工具参数开启计费。

## 安全与限制

- 未授权时不读取服务商密钥、凭据库或认证额度接口。
- 授权后提前读取 `EXA_API_KEY`、`TAVILY_API_KEY`、`PARALLEL_API_KEY`、`FIRECRAWL_API_KEY` 以完整脱敏；取钥或格式错误会阻止整次搜索。TinyFish 始终无密钥。
- 仅支持可信环境注入密钥，不调用带明文文件回退的 `ctx.credentials`。不要把密钥写入聊天、命令参数、配置、日志或仓库。
- 额度预检、缓存与预留只在同实例内降低风险，不证明免费，也不提供账号级或跨进程账单硬上限。
- 冷却文件仅含私有盐值、HMAC 作用域和冷却元数据，目录 `0700`、文件 `0600`；拒绝不安全状态，不覆盖未知文件或修改既有权限。
- 私有持久化仅验收 Linux 与 macOS；Windows 使用内存状态并警告，不能跨重启恢复。存储故障也会降级警告。
- 冷却尽快、有界保存，但不保证跨进程实时同步或断电、强杀时零丢失；同步代码和已开始的系统磁盘操作不能强行中断。
- 43 项离线检查、桌面内置节点和干净源码入口检查通过；这不等于真实桌面升级、界面启用、模型会话或服务商网络验收。

## 开发验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run check:artifacts
npm pack --dry-run
```

修改源码须同步提交 `lib/` 编译产物。`npm run smoke` 是手动匿名网络检查，不进入持续集成，不使用密钥或计费通道。

每次版本变更完成验证和安全审计后提交推送；不强制推送、不自动发布到 npm，也不自动升级用户安装。维护约定见 [AGENTS.md](AGENTS.md)。
