export declare const SPILL_MAX_BYTES: number;
export interface SpillResult {
    path: string;
    complete: boolean;
}
/** 每次操作重新锚定系统临时根，允许 macOS /var 等系统符号链接。 */
export declare function spillFullText(text: string, temporaryRoot?: string): Promise<SpillResult>;
