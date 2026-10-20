# 安全审计裁定记录

本文记录本仓库对离线安全扫描命中项的逐条裁定。

**这不是"审计通过"的证明。** 裁定依据是人工核对每条命中的实际内容；
扫描器规则本身是基于模式匹配的启发式，无法区分真实凭据与说明性文字。

## 结论

- 独立检查：跟踪文件与全部提交历史中**没有真实凭据**。
  - 对 `git ls-files` 全部文件搜索 `sk-…` / `AKIA…` / `ghp_…` / 私钥头：0 处
  - 对 `git log --all -p` 全历史搜索同一组模式：0 处
- 扫描器报告的 17 条阻断项，逐条核对后**全部为误报**，理由见下表。
- 436 条待审项按规则归类后同样为模式命中，未发现可用凭据。
- 扫描器基线（`known` / `false_positive`）**尚未登记**：登记需要扫描器
  自身的基线写入能力，本仓库没有该工具。本文是登记前的裁定依据。

## 方法与证据

1. 独立模式搜索（不依赖扫描器）：见上文两处"0 处"。
2. 逐条读取命中行内容，判断它是"值"还是"字段名／说明文字"。
3. 测试夹具只使用虚构值（`test-key`、`offline-spill-secret`、
   RFC 5737 文档地址 `203.0.113.0/24` 等）。

## 阻断项逐条裁定（17 条）

| # | 规则 | 位置 | 实际内容 | 裁定 |
| --- | --- | --- | --- | --- |
| 1 | SENSITIVE_CONFIG_ASSIGNMENT | src/quota/core.ts:72 | `credential: string;` | 误报：接口字段的类型声明，无值 |
| 2 | SENSITIVE_CONFIG_ASSIGNMENT | src/quota/usage.ts:16 | `credential: string;` | 误报：同上 |
| 3 | SENSITIVE_CONFIG_ASSIGNMENT | lib/quota/core.d.ts:43 | 同上（编译产物） | 误报：与 #1 同源 |
| 4 | SENSITIVE_CONFIG_ASSIGNMENT | lib/quota/usage.d.ts:15 | 同上（编译产物） | 误报：与 #2 同源 |
| 5 | CREDENTIAL_URL | src/search/core.ts:49 | 关键词表 `invalid api key` / `api key` | 误报：错误分类关键词，非 URL |
| 6 | CREDENTIAL_URL | lib/search/core.js:43 | 同上（编译产物） | 误报：与 #5 同源 |
| 7 | CREDENTIAL_URL | lib/search/core.d.ts:20 | 注释里的"带内嵌凭据地址"占位符写法 | 误报：占位符形式的说明文字 |
| 8 | CREDENTIAL_URL | tests/fetch/url-policy.test.mjs:62 | 测试用例中的内嵌凭据地址，域名为 example.com | 误报：故意构造的拒收用例输入 |
| 9 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/auth.test.mjs:629 | `EXA_API_KEY: undefined` | 误报：清空环境变量 |
| 10 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/backends.test.mjs:154 | `api_key: TAVILY_KEY` | 误报：引用测试常量，值为虚构 |
| 11 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/mock.test.mjs:46 | `credentialStore: …` | 误报：注入替身的字段名 |
| 12 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/mock.test.mjs:126 | `EXA_API_KEY: undefined` | 误报：清空环境变量 |
| 13 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/spill-cleanup-integration.test.mjs:41 | `EXA_API_KEY: undefined` | 误报：清空环境变量 |
| 14 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/spill-failure.test.mjs:41 | `EXA_API_KEY: "offline-spill-secret"` | 误报：虚构值，名称已标明 offline |
| 15 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/spill-failure.test.mjs:42 | `PARALLEL_API_KEY: undefined` | 误报：清空环境变量 |
| 16 | SENSITIVE_CONFIG_ASSIGNMENT | tests/pi/total-budget.test.mjs:28 | `EXA_API_KEY: undefined` | 误报：清空环境变量 |
| 17 | CREDENTIAL_URL | git:commit-object:f3ee9dbd…:8 | 历史对象中的同一段注释 | 误报：与 #7 同源的历史版本 |

## 待审项分类裁定（436 条）

| 规则 | 条数 | 命中原因 | 裁定 |
| --- | --- | --- | --- |
| `IGNORED_CONFIG_VALUE_EXPOSED` | 350 | 说明性文字里的"凭据""密钥""配置"等词，例如 README 的目录树注释 | 误报：自然语言描述 |
| `EXPOSED_RUNTIME_CONFIG_ASSIGNMENT` | 58 | 类型声明里的 `url: URL`、`key: string` 等字段 | 误报：类型字段名 |
| `SENSITIVE_CONFIG_ASSIGNMENT` | 24 | `credential`／`api_key` 字段与测试替身 | 误报：见上表 |
| `IP_ADDRESS` | 9 | RFC 1918／RFC 5737 说明性网段，如注释 `10.0.0.0/8 私有` | 误报：文档地址与注释 |
| `NON_IGNORED_RUNTIME_CONFIG` | 6 | 环境变量读取（`process.env.PI_WEB_SEARCH_*`） | 误报：读取不是泄露 |
| `CREDENTIAL_URL` | 5 | 见上表 #5–#8 | 误报 |
| `HIGH_ENTROPY_ASSIGNMENT` | 4 | npm `integrity` 的 sha512、测试盐文件 | 误报：哈希与随机盐 |

## 第六次扫描（v0.2.3 前）

本次扫描共 18 项阻断、439 项待审。相对上一轮新增的阻断来自
`SECURITY.md` 自身：本文为了说明裁定对象，引用了被判定位置的原文，
其中"带内嵌凭据地址"的写法又触发同一条规则。已改为描述性表述，
不再逐字复制触发模式。

其余命中与上文分类一致，未发现新的真实凭据。

## 已知遗留

- **悬空提交 `55f026b`**：本仓库一次误提交（把测试夹具
  `tests/.round4-fixtures/` 带入了提交），随后用 `--amend` 修正。
  该提交已不在任何分支上，但对象仍在 `.git` 里，扫描器能读到。
  其中的 `quota-salt.json` 是 32 字节随机盐，不是凭据。
  本文不删除它：清理不可达对象属于仓库所有者的决定，
  删除历史对象也会削弱可审计性。
- 扫描器对"凭据"的判断依赖变量名与字符串形状，无法区分
  `credential: string` 这类类型声明与真实赋值。

## 未覆盖范围

- 未做真实宿主安装、真实系统密钥库或真实服务商请求的验收。
- 未覆盖远端不可达且未公开的已删除对象、持续集成日志与制品。
- 未评估扫描器规则本身的可信度。
