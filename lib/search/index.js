/**
 * 搜索内核：宿主无关的路由、协议、额度与脱敏。
 *
 * 两个宿主（DSH / Pi）只负责把各自的请求形态转换成这里的输入，
 * 不在此模块内读取任何宿主配置或凭据服务。
 */
export { createSearchEngine, renderOutcome, renderSources, redactSecrets, extractSources } from "./engine.js";
export { PROVIDER_IDS, PROVIDERS, getProviderMetadata, isProviderId, hasAnonymousChannel, supportsKeyChannel } from "./registry.js";
export { readRoutingConfig, buildRouteCandidates, getRoutingStatus } from "./routing.js";
