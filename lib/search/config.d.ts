/** 搜索请求配置只读取一次，非法值不回显。 */
export interface SearchRequestConfig {
    retries: number;
    timeoutMs: number;
    /** 整次调用（所有通道、重试、退避等待与正文落盘合计）的总时间预算上限。 */
    totalTimeoutMs: number;
}
export declare function readSearchRequestConfig(env?: NodeJS.ProcessEnv): SearchRequestConfig;
