/** 抓取操作共用的绝对截止时间与取消控制。 */
/** 建立单一预算；deadlineMs 是基于 performance.now() 的绝对截止时刻。 */
export declare function createFetchDeadline(timeoutMs: number, externalSignal?: AbortSignal, deadlineMs?: number): {
    signal: AbortSignal;
    deadlineMs: number;
    check(): void;
    run<T>(operation: () => T | PromiseLike<T>): Promise<T>;
    dispose(): void;
};
