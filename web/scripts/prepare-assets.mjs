import { mkdir, copyFile, cp } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const output = new URL('public/vendor/', root);
await mkdir(output, { recursive: true });
for (const [pkg, name] of [['mediabunny', 'mediabunny'], ['@mediabunny/mp3-encoder', 'mp3-encoder']]) {
  await copyFile(new URL(`node_modules/${pkg}/LICENSE`, root), new URL(`${name}-LICENSE.txt`, output));
}

await copyFile(new URL('node_modules/cadical-wasm/dist/cadical.wasm', root), new URL('cadical.wasm', output));
await copyFile(new URL('node_modules/cadical-wasm/LICENSE', root), new URL('cadical-LICENSE.txt', output));
await copyFile(new URL('scripts/vorbis-validator/artifacts/vorbis-validator.wasm', root), new URL('vorbis-validator.wasm', output));
await cp(new URL('scripts/vorbis-validator/licenses/', root), new URL('vorbis-validator-licenses/', output), { recursive: true });
