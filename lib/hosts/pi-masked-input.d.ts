/** 只渲染掩码的终端密钥输入；不使用带明文渲染、撤销栈或剪切环的普通输入组件。 */
import { type Component, type Focusable } from "@earendil-works/pi-tui";
export declare class MaskedInput implements Component, Focusable {
    private readonly title;
    private readonly done;
    private readonly requestRender;
    focused: boolean;
    private value;
    private cursor;
    private error;
    private closed;
    private pasting;
    private pasteValue;
    private pasteTail;
    private pasteInvalid;
    constructor(title: string, done: (value: string | undefined) => void, requestRender?: () => void);
    handleInput(data: string): void;
    private insert;
    /** 流式识别跨数据块的粘贴结束标记；超长或含控制字符的粘贴整体拒绝，不截断密钥。 */
    private consumePaste;
    render(width: number): string[];
    invalidate(): void;
    private finish;
    /** 清除组件对凭据的引用；字符串的物理内存擦除不由 JavaScript 保证。 */
    dispose(): void;
}
