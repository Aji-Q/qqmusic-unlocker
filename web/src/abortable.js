/**
 * Await work with prompt cancellation and an optional deadline.
 * onAbort is best-effort cleanup; it never delays or replaces the rejection.
 * The underlying promise remains observed even if it settles after cancellation.
 */
export function abortable(promise, signal, { timeoutMs, onAbort } = {}) {
  const work = Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (callback, value) => {
      if (settled) return false;
      settled = true;
      cleanup();
      callback(value);
      return true;
    };
    const interrupt = (error) => {
      if (!finish(reject, error)) return;
      try {
        // Cleanup may itself be asynchronous or fail. Neither case should
        // strand the UI or create an unhandled rejection.
        Promise.resolve(onAbort?.(error)).catch(() => {});
      } catch { /* Preserve the abort/timeout error. */ }
    };
    const abort = () => interrupt(signal?.reason ?? new DOMException('已停止', 'AbortError'));

    // Attach both handlers before checking an already-aborted signal.
    work.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      timer = setTimeout(() => {
        const error = new Error('处理超时，请重试或使用桌面版。');
        error.name = 'TimeoutError';
        error.code = 'timeout';
        interrupt(error);
      }, timeoutMs);
    }
  });
}
