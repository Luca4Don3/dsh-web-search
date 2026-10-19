export declare const SPILL_MAX_BYTES: number;
export interface SpillResult {
    path: string;
    complete: boolean;
}
/** 每次操作重新锚定系统临时根，允许 macOS /var 等系统符号链接。 */
/**
 * 删除本次落盘产生的文件。
 *
 * 只删除严格命名、属于当前用户、私有权限且为单链接的普通文件；
 * 任何校验不通过都保持原样。用于"落盘被取消但后台已完成"的回收路径。
 */
export declare function discardSpillFile(path: string): Promise<void>;
export declare function spillFullText(text: string, temporaryRoot?: string): Promise<SpillResult>;
