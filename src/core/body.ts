/** 有界读取解压后的响应流，并在取消或超限时消费迟到结果。 */

export class CoreFault extends Error {
  constructor(readonly kind: "aborted" | "timeout" | "too_large" | "network" | "protocol" | "rate" | "exhausted" | "other") {
    super(kind);
    this.name = "CoreFault";
  }
}

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { void Promise.resolve(reader.cancel()).catch(() => undefined); } catch { /* 清理错误不覆盖主错误。 */ }
}
function waitForRead(
  pending: Promise<ReadableStreamReadResult<Uint8Array>>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); callback(); };
    const abort = (): void => finish(() => reject(new CoreFault("aborted")));
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}

/** 以字节计数，超限不返回部分正文；signal 忽略者也不会拖住调用方。 */
export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  abortNetwork?: () => void,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) throw new CoreFault("protocol");
  if (signal.aborted) throw new CoreFault("aborted");
  if (response.body === null) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); } catch { throw new CoreFault("network"); }
  let done = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const onAbort = (): void => cancelReader(reader);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let total = 0;
    for (;;) {
      if (signal.aborted) throw new CoreFault("aborted");
      let raw: Promise<ReadableStreamReadResult<Uint8Array>>;
      try { raw = Promise.resolve(reader.read()); } catch { throw new CoreFault(signal.aborted ? "aborted" : "network"); }
      pending = raw.then((value) => value, () => { throw new CoreFault(signal.aborted ? "aborted" : "network"); });
      const item = await waitForRead(pending, signal);
      pending = undefined;
      if (signal.aborted) throw new CoreFault("aborted");
      if (item.done) {
        const tail = decoder.decode();
        if (tail.length > 0) parts.push(tail);
        done = true;
        return parts.join("");
      }
      total += item.value.byteLength;
      if (total > maxBytes) {
        abortNetwork?.();
        cancelReader(reader);
        throw new CoreFault("too_large");
      }
      const text = decoder.decode(item.value, { stream: true });
      if (text.length > 0) parts.push(text);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!done) cancelReader(reader);
    const release = (): void => { try { reader.releaseLock(); } catch { /* 尚未完成的读取在迟到后再次释放。 */ } };
    if (pending !== undefined) void pending.then(release, release);
    release();
  }
}
