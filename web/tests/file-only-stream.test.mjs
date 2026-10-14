import test from 'node:test';
import assert from 'node:assert/strict';
import { Rc4Cipher, decryptFile } from '../src/qmc.js';
import { recoverOggStream } from '../src/file-only-stream.js';
import { vorbisTemplates } from '../src/vorbis-templates.js';

const text = new TextEncoder();
const u32 = value => Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
const join = arrays => {
  const result = new Uint8Array(arrays.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of arrays) { result.set(bytes, offset); offset += bytes.length; }
  return result;
};
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  value <<= 24;
  for (let bit = 0; bit < 8; bit += 1) value = ((value << 1) ^ (value < 0 ? 0x04c11db7 : 0));
  return value >>> 0;
});
function page(sequence, packets, flags = 0) {
  const lacing = packets.flatMap(bytes => [...Array(Math.floor(bytes.length / 255)).fill(255), bytes.length % 255]);
  const header = new Uint8Array(27);
  header.set(text.encode('OggS'));
  header[5] = flags;
  header.set(u32(sequence * 1024), 6);
  header.set(u32(0x2468ac71), 14);
  header.set(u32(sequence), 18);
  header[26] = lacing.length;
  const result = join([header, Uint8Array.from(lacing), ...packets]);
  let crc = 0;
  for (const value of result) crc = ((crc << 8) ^ table[((crc >>> 24) ^ value) & 255]) >>> 0;
  result.set(u32(crc), 22);
  return result;
}

// Synthetic Ogg framing and random packet bodies exercise recovery, not audio
// decoding. No recording, external key, downloaded fixture or FFmpeg is needed.
function syntheticContainer() {
  let random = 2026;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  const key = Uint8Array.from({ length: 512 }, () => 1 + next() % 255);
  const identification = new Uint8Array(30);
  identification.set(text.encode('\x01vorbis'));
  identification[11] = 2;
  identification.set(u32(44100), 12);
  identification[28] = 0xb8;
  identification[29] = 1;
  const vendor = text.encode('Xiph.Org libVorbis I 20150105 (\u26c4\u26c4\u26c4\u26c4)');
  const tags = [
    'TITLE=A synthetic packet-layout regression with a longer title',
    'COMMENT=Different lengths must not require readable metadata',
    'ARTIST=Independent test data',
    'ENCODER=Public codec tables',
  ].map(value => text.encode(value));
  const comments = join([text.encode('\x03vorbis'), u32(vendor.length), vendor, u32(tags.length),
    ...tags.flatMap(bytes => [u32(bytes.length), bytes]), Uint8Array.of(1)]);
  const setup = vorbisTemplates().find(({ id }) => id === 'libvorbis-stereo-q9,10').bytes;
  const pages = [page(0, [identification], 2), page(1, [comments, setup])];
  for (let sequence = 2; sequence < 1602; sequence += 1) {
    const body = Uint8Array.from({ length: 4000 + next() % 801 }, () => next() >>> 24);
    pages.push(page(sequence, [body], sequence === 1601 ? 4 : 0));
  }
  const plain = join(pages);
  const encrypted = plain.slice();
  const cipher = new Rc4Cipher(key);
  cipher.decrypt(0, encrypted);
  return { cipher, key, plain, encrypted };
}

test('variable metadata and short repeated streams recover only correct independent observations', { timeout: 90_000 }, async () => {
  const { cipher, key, plain, encrypted } = syntheticContainer();
  assert.ok(encrypted.length < 1537 * 5120, 'exercise a body below the old size cutoff');
  const recovered = recoverOggStream(encrypted);
  const reference = cipher.segmentKey(0, key[0]) & 511;
  assert.ok(recovered.known.size >= 4096);
  assert.equal(new Set([...recovered.shifts.keys()].map(segment => segment & 511)).size, 512);
  for (const [segment, shift] of recovered.shifts) {
    assert.equal(shift, (cipher.segmentKey(segment, key[segment & 511]) & 511) - reference);
    const first = Math.max(128, segment * 5120);
    const last = Math.min(encrypted.length, (segment + 1) * 5120);
    for (let offset = first; offset < last; offset += 1) {
      const value = recovered.known.get(offset % 5120 + shift);
      if (value !== undefined) assert.equal(encrypted[offset] ^ value, plain[offset]);
    }
  }
  // Exercise the public route too: the Ogg verifier returns diagnostics, not
  // replacement audio. A renamed input must still return the original bytes.
  const footer = join([u32(16), u32(1), text.encode('musicex\0')]);
  const file = new File([encrypted, footer], 'independent-container.bin');
  const result = await decryptFile(file);
  assert.equal(result.extension, '.ogg');
  assert.equal(result.data.length, plain.length);
  assert.equal(Buffer.compare(result.data, plain), 0);
});
