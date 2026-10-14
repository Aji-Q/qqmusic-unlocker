import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { abortable } from '../src/abortable.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = () => new Promise(() => {});

test('normal resolve/reject retains the result and removes the abort listener', async () => {
  const controller = new AbortController();
  assert.equal(await abortable(Promise.resolve('done'), controller.signal, { timeoutMs: 10000 }), 'done');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const original = new Error('original');
  await assert.rejects(abortable(Promise.reject(original), controller.signal), error => error === original);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort rejects immediately even if work and asynchronous cleanup never settle', async () => {
  const controller = new AbortController();
  let cleanupCalls = 0;
  const result = abortable(pending(), controller.signal, {
    timeoutMs: 10000,
    onAbort(error) {
      cleanupCalls += 1;
      assert.equal(error.name, 'AbortError');
      return pending();
    },
  });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(cleanupCalls, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an already-aborted signal observes the input promise and cleans up exactly once', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(abortable(Promise.reject(new Error('late input error')), controller.signal, {
    onAbort() { calls += 1; },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await delay(0);
});

test('timeout rejects with a Chinese actionable error and cleans the listener', async () => {
  const controller = new AbortController();
  let cleanupError;
  await assert.rejects(abortable(pending(), controller.signal, {
    timeoutMs: 5,
    onAbort(error) { cleanupError = error; },
  }), error => error.code === 'timeout' && error.message.includes('超时'));
  assert.equal(cleanupError.name, 'TimeoutError');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('late resolution and rejection after abort do not create unhandled failures', async () => {
  const errors = [];
  const onUnhandled = reason => errors.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const rejectLate of [false, true]) {
      const controller = new AbortController();
      let settle;
      const work = new Promise((resolve, reject) => { settle = rejectLate ? reject : resolve; });
      const result = abortable(work, controller.signal, { onAbort: () => Promise.reject(new Error('cleanup error')) });
      controller.abort();
      await assert.rejects(result, { name: 'AbortError' });
      settle(rejectLate ? new Error('late work error') : 'late success');
    }
    await delay(10);
    assert.deepEqual(errors, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('settled work cancels its timeout and does not call cleanup after a later abort', async () => {
  const controller = new AbortController();
  let calls = 0;
  assert.equal(await abortable(Promise.resolve(42), controller.signal, {
    timeoutMs: 5,
    onAbort() { calls += 1; },
  }), 42);
  controller.abort();
  await delay(10);
  assert.equal(calls, 0);
});

test('cleanup throws do not replace the original abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('stop requested');
  const result = abortable(pending(), controller.signal, {
    onAbort() { throw new Error('cleanup failed'); },
  });
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
});

test('an optional signal supports timeout-only work and ordinary values', async () => {
  assert.equal(await abortable(7), 7);
  await assert.rejects(abortable(pending(), undefined, { timeoutMs: 0 }), { name: 'TimeoutError' });
});
