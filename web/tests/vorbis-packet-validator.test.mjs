import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createValidatorFactory } from '../src/vorbis-packet-validator.js';

// This repository fixture contains independently generated synthetic audio.
function unpack(bytes) {
  const packets = [];
  let offset = 0, chunks = [], size = 0;
  while (offset < bytes.length) {
    assert.equal(String.fromCharCode(...bytes.subarray(offset, offset + 4)), 'OggS');
    const count = bytes[offset + 26];
    let body = offset + 27 + count;
    for (let i = 0; i < count; i++) {
      const length = bytes[offset + 27 + i];
      assert.ok(body + length <= bytes.length);
      chunks.push(bytes.subarray(body, body + length));
      size += length;
      body += length;
      if (length < 255) {
        const packet = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) { packet.set(chunk, at); at += chunk.length; }
        packets.push(packet);
        chunks = []; size = 0;
      }
    }
    offset = body;
  }
  assert.equal(size, 0);
  return packets;
}

const packets = unpack(await readFile(new URL('./fixtures/synthetic-control.ogg', import.meta.url)));
const headers = packets.slice(0, 3), audio = packets.slice(3);
const make = await createValidatorFactory();

function usingValidator(run) {
  const validator = make(headers);
  try { return run(validator); } finally { validator.dispose(); }
}

test('accepts every complete packet in the public synthetic fixture', () => usingValidator(v => {
  assert.equal(v.profileOK, true);
  assert.equal(v.profile.channels, 2);
  assert.equal(v.profile.rate, 44100);
  assert.deepEqual(v.profile.modeBlockflags, [0, 1]);
  assert.ok(audio.length > 50);
  for (const packet of audio) assert.equal(v.validatePacket(packet), true);
}));

test('rejects truncated, excess-padded, and nonzero-padded packets', () => usingValidator(v => {
  const packet = audio.find(bytes => bytes.length > 50);
  assert.ok(packet);
  // Exercise the look-ahead EOF branch that does not advance oggpack_bits.
  assert.equal(v.inspect(packet.subarray(0, Math.floor(packet.length / 2))).status, -10);
  for (const original of [audio[0], packet, audio.at(-1)]) {
    for (let cut = 1; cut < original.length; cut++) {
      assert.equal(v.validatePacket(original.subarray(0, cut)), false, `accepted ${cut}/${original.length} bytes`);
    }
  }
  const extended = new Uint8Array(packet.length + 1);
  extended.set(packet);
  assert.equal(v.inspect(extended).status, -9);
  const padded = audio.find(bytes => v.inspect(bytes).remaining > 0);
  assert.ok(padded);
  const { consumed } = v.inspect(padded);
  const changed = padded.slice();
  changed[consumed >>> 3] |= 1 << (consumed & 7);
  assert.equal(v.inspect(changed).status, -8);
}));

test('header profile restrictions reject unsupported channels and bitrate bounds', () => {
  const mono = headers.map(bytes => bytes.slice());
  mono[0][11] = 1;
  assert.throws(() => make(mono), /Unsupported Vorbis profile \(-20\)/);
  const managed = headers.map(bytes => bytes.slice());
  new DataView(managed[0].buffer).setInt32(16, 128000, true);
  assert.throws(() => make(managed), /Unsupported Vorbis profile \(-21\)/);
  const invalid = headers.map(bytes => bytes.slice());
  invalid[2][0] = 1;
  assert.throws(() => make(invalid), /Unsupported Vorbis profile/);
});

test('candidate packets can be checked in reverse order after failures', () => usingValidator(v => {
  assert.equal(v.validatePacket(Uint8Array.of(255)), false);
  for (const packet of [...audio].reverse()) assert.equal(v.validatePacket(packet), true);
}));

test('validates JS inputs and releases contexts once', () => {
  assert.throws(() => make(headers.slice(0, 2)), /Three Vorbis headers/);
  const v = make(headers);
  assert.throws(() => v.inspect(new Uint8Array(0)), /Invalid Vorbis packet/);
  assert.throws(() => v.inspect(new Uint8Array(131073)), /Invalid Vorbis packet/);
  v.dispose(); v.dispose(); v.close();
  assert.throws(() => v.validatePacket(audio[0]), /Validator closed/);
});
