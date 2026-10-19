/**
 * 额度内核的纯类型切片。
 *
 * 拆出来是为了让 `search/routing.ts` 这类纯模块只依赖类型，
 * 不把 Node 的 fs / crypto 拖进任何依赖图。
 */
export {};
