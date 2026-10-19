/**
 * DSH 0.1.x 的 `CoreFault` 兼容类型。
 *
 * 旧实现还在这里自带了一套有界响应体读取；合并后统一由
 * {@link ../shared/response-body.js} 提供，因此本文件只保留错误类型，
 * 避免出现第二份字节计数与取消逻辑。
 */
export class CoreFault extends Error {
    kind;
    constructor(kind) {
        super(kind);
        this.kind = kind;
        this.name = "CoreFault";
    }
}
