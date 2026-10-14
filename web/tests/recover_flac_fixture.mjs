/**
 * Optional blind integration harness (Node 22+).
 * node tests/recover_flac_fixture.mjs INPUT.mflac OUTPUT.flac
 * Expose only inputs/ to this process. Compare the printed output hash with
 * private/manifest.json in a separate validation process after recovery.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decryptFile } from '../src/qmc.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: recover_flac_fixture.mjs INPUT.mflac OUTPUT.flac');
const bytes = await readFile(input);
const started = performance.now();
const result = await decryptFile(new File([bytes], 'unrelated-file-name.mflac'));
if (!result.decrypted || result.extension !== '.flac') throw new Error('Expected fully verified decrypted FLAC');
await writeFile(output, result.data, { mode: 0o600 });
console.log(JSON.stringify({
  bytes: result.data.length,
  sha256: createHash('sha256').update(result.data).digest('hex'),
  seconds: (performance.now() - started) / 1000,
}));
