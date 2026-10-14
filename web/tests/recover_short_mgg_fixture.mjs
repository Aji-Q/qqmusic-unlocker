#!/usr/bin/env node
/** Public product-path smoke runner. Reads one encrypted input; no oracle/key API. */
import { readFile, writeFile, access } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { decryptFile } from '../src/qmc.js';
import { verifyRecoveredOgg } from '../src/file-only-key.js';

const args = process.argv.slice(2);
const expectRejection = args.includes('--expect-rejection');
const paths = args.filter(arg => arg !== '--expect-rejection');
if (paths.length !== 2) {
  console.error('Usage: node recover_short_mgg_fixture.mjs INPUT.mgg OUTPUT.ogg [--expect-rejection]');
  process.exit(1);
}
const [input, output] = paths;
try { await access(output); throw new Error(`Output already exists: ${output}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const encrypted = await readFile(input);
const started = performance.now();
let result;
try {
  result = await decryptFile(new File([encrypted], basename(input)));
} catch (error) {
  // An operational failure is not proof that the input was safely rejected.
  const unresolved = ['file_only_unsupported', 'recovery_timeout'].includes(error.code);
  console.log(JSON.stringify({ status: unresolved ? 'unresolved' : 'error', code: error.code,
    message: error.message, seconds: (performance.now() - started) / 1000 }));
  process.exit(error.code === 'file_only_unsupported' && expectRejection ? 0 : unresolved ? 2 : 1);
}
if (expectRejection) throw new Error('Unexpected recovery; requested a rejection fixture');
if (!result.decrypted || result.extension !== '.ogg') throw new Error('Expected encrypted Ogg recovery');
verifyRecoveredOgg(result.data);
await writeFile(output, result.data, { flag: 'wx' });
console.log(JSON.stringify({ status: 'recovered', bytes: result.data.length,
  sha256: createHash('sha256').update(result.data).digest('hex'),
  seconds: (performance.now() - started) / 1000, output }));
