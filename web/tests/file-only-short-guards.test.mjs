import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverShortOgg } from '../src/file-only-short-ogg.js';

test('large inputs stop before short-file analysis exceeds its memory budget', async () => {
  let analysisStarted = false;
  await assert.rejects(
    recoverShortOgg(new Uint8Array(100 * 1024 * 1024), () => {}, {
      onStage() {
        analysisStarted = true;
      },
    }),
    (error) => error.code === 'recovery_unresolved' && /memory budget/.test(error.message),
  );
  assert.equal(analysisStarted, false);
});

test('cancellation propagates from candidate discovery without producing output', async () => {
  const cancellation = new Error('Cancelled by caller');
  cancellation.code = 'recovery_timeout';
  let checks = 0;
  await assert.rejects(
    recoverShortOgg(new Uint8Array(2 * 1024 * 1024), () => {}, {
      checkpoint() {
        checks++;
        throw cancellation;
      },
    }),
    (error) => error === cancellation,
  );
  assert.equal(checks, 1);
});
