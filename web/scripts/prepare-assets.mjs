import { mkdir, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const output = new URL('public/vendor/', root);
await mkdir(output, { recursive: true });
for (const [pkg, name] of [['mediabunny', 'mediabunny'], ['@mediabunny/mp3-encoder', 'mp3-encoder']]) {
  await copyFile(new URL(`node_modules/${pkg}/LICENSE`, root), new URL(`${name}-LICENSE.txt`, output));
}
