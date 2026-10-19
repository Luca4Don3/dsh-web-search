# 来源与版权说明

本项目的搜索与抓取内核来自 `Luca4Don3/pi-extensions` 的 `web-search` 与 `web-fetch`
（MIT 许可证，模块版本 `0.6.0-beta.3` 与 `0.1.0-beta.2`），并参考
`deepseek-ai/deepseek-harness`（`dsh-v0.2.0-rc.2`）的公开接口重建了 DSH 宿主适配层。

## 合并方式

自 `0.2.0` 起，两个模块并入本仓库，改造成「宿主无关内核 + 两套薄适配层」：

- `src/search`、`src/fetch`、`src/quota`、`src/auth`、`src/shared`：宿主无关内核
- `src/hosts/dsh.ts`：DSH 的 `ctx.web` 搜索与抓取提供方
- `src/hosts/pi.ts`、`src/hosts/pi-fetch.ts`：Pi 的 `web_search` / `web_fetch` 工具与 `/web-search-auth`
- `src/compat`：DSH 0.1.x 的额度与状态接口兼容层

内核不 `import` 任何宿主 API；Pi 与 DSH 的依赖都是可选 peer，只装其中一个也能工作。

## 相对上游的改动

- 两套重复实现（响应体上限常量、`Retry-After` 解析、有界读流）合并为共享模块，
  差异以配置项表达而不是复制代码
- 新增 DSH 侧抓取提供方（`local-first`）
- 新增 `src/compat` 兼容层，使 `0.1.x` 的调用方无需修改

## 许可证

本项目与上游均为 MIT。许可证中的英文原文附中文译文；中文译文仅供理解，以英文原文为准。
依赖的许可证以对应依赖包的许可证为准。
