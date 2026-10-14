import test from 'node:test';
import assert from 'node:assert/strict';
import { Rc4Cipher } from '../src/qmc.js';
import { solvePrefix } from '../src/file-only-ogg-prefix.js';
import { completeStream } from '../src/file-only-ogg-equations.js';
import { refineLacing } from '../src/file-only-ogg-lacing.js';

const text = new TextEncoder();
const allBytes = Array.from({ length: 256 }, (_, value) => value);
const u32 = (value) =>
  Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
const join = (...arrays) => {
  const result = new Uint8Array(arrays.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of arrays) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
};

// Independent, bit-at-a-time Ogg CRC writer. These are synthetic containers for
// constraint tests, not playable audio and not fixtures derived from a recording.
function page(sequence, packets, flags = 0) {
  const lacing = packets.flatMap((packet) => [
    ...Array(Math.floor(packet.length / 255)).fill(255),
    packet.length % 255,
  ]);
  const header = new Uint8Array(27);
  header.set(text.encode('OggS'));
  header[5] = flags;
  header.set(u32(0x2468ac71), 14);
  header.set(u32(sequence), 18);
  header[26] = lacing.length;
  const result = join(header, Uint8Array.from(lacing), ...packets);
  let crc = 0;
  for (const byte of result) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
    }
  }
  result.set(u32(crc >>> 0), 22);
  return result;
}

function prefixFixture() {
  const identification = new Uint8Array(30);
  identification.set(text.encode('\x01vorbis'));
  identification[11] = 2;
  identification.set(u32(44100), 12);
  identification.set(u32(320000), 20);
  identification[28] = 0xb8;
  identification[29] = 1;
  const comment = join(
    text.encode('\x03vorbis'),
    u32(1),
    text.encode('X'),
    u32(0),
    Uint8Array.of(1),
  );
  const setup = new Uint8Array(152);
  setup.set(text.encode('\x05vorbis'));
  const plain = join(page(0, [identification], 2), page(1, [comment, setup]));

  // Find five independent mask cells that affect only sample-rate/bitrate bytes.
  // Their 40 unknown bits cannot be determined by the first page's 32-bit CRC.
  // All values are generated here; no external key, plaintext or cache is read.
  for (let seed = 1; seed <= 100; seed += 1) {
    let random = seed;
    const key = Uint8Array.from({ length: 512 }, () => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return 1 + ((random >>> 24) % 255);
    });
    const cipher = new Rc4Cipher(key);
    const shifts = Array.from({ length: 128 }, (_, position) => [
      position,
      cipher.segmentKey(position, key[position]) & 511,
    ]);
    const cells = [...new Set(shifts.slice(40, 56).map(([, index]) => index))]
      .filter(
        (index) =>
          index >= 128 &&
          shifts.every(([position, other]) => other !== index || (position >= 40 && position < 56)),
      )
      .slice(0, 5);
    if (cells.length !== 5) continue;
    const encrypted = plain.slice();
    cipher.decrypt(0, encrypted);
    const known = [];
    for (let position = 128; position < plain.length; position += 1) {
      known.push([position + shifts[0][1], plain[position] ^ encrypted[position]]);
    }
    const observations = {
      known,
      shifts,
      serial: [...u32(0x2468ac71)],
      commentStart: 87,
      setupStart: 87 + comment.length,
      setupLength: setup.length,
      vendor: 'X',
    };
    const exact = { hash: cipher.hash, reference: 0, choices: [...key].map((value) => [value]) };
    const broad = {
      ...exact,
      choices: exact.choices.map((values, index) =>
        cells.includes(index) ? [...allBytes] : values,
      ),
    };
    return { plain, encrypted, observations, exact, broad };
  }
  throw new Error('Synthetic seed search did not create an ambiguous prefix');
}

test('an exact original prefix is returned without replacing codec parameters', () => {
  const { plain, encrypted, observations, exact } = prefixFixture();
  const recovered = solvePrefix(encrypted, observations, [exact]);
  assert.deepEqual(recovered.prefix, plain.subarray(0, 128));
  assert.deepEqual(recovered.data, plain);
});

test('CRC-valid but ambiguous sample-rate/bitrate bytes are rejected, not guessed', () => {
  const { encrypted, observations, broad } = prefixFixture();
  assert.throws(
    () => solvePrefix(encrypted, observations, [broad]),
    (error) => {
      assert.match(error.message, /Prefix is not unique/);
      assert.equal(error.unresolved, 0, 'the candidates were actually searched');
      assert.ok(error.ambiguities.some((position) => position >= 40 && position < 56));
      return true;
    },
  );
});

test('a search-budget branch prevents uniqueness even when another candidate succeeds', () => {
  const { encrypted, observations, exact, broad } = prefixFixture();
  for (const candidates of [
    [broad, exact],
    [exact, broad],
  ]) {
    assert.throws(
      () => solvePrefix(encrypted, observations, candidates, { maxFree: 0 }),
      (error) => {
        assert.match(error.message, /Prefix is not unique \(1, unresolved 1\)/);
        assert.equal(error.unresolved, 1);
        return true;
      },
    );
  }
});

test('prefix search propagates cancellation instead of returning a partial answer', () => {
  const { encrypted, observations, broad } = prefixFixture();
  const cancelled = new Error('cancelled by test');
  assert.throws(
    () =>
      solvePrefix(encrypted, observations, [broad], {
        checkpoint: () => {
          throw cancelled;
        },
      }),
    (error) => error === cancelled,
  );
});

function bodyFixture(packets = [new Uint8Array(64)]) {
  const start = 128;
  const data = join(new Uint8Array(start), page(2, packets, 4));
  return {
    data,
    observation: {
      known: Array.from({ length: 5631 }, (_, index) => [index, 0]),
      shifts: [[0, 0]],
      pages: [{ offset: start }],
    },
    candidate: { hash: 0, reference: 0, choices: Array.from({ length: 512 }, () => [0]) },
  };
}

test('original page CRC recovers four erased bytes but cannot uniquely recover five', () => {
  for (const count of [4, 5]) {
    const { data, observation, candidate } = bodyFixture();
    const erased = Array.from({ length: count }, (_, index) => 162 + index);
    observation.known = observation.known.filter(([index]) => !erased.includes(index));
    const recovered = completeStream(data, observation, candidate, { system: true });
    if (count === 4) {
      assert.equal(recovered.stats.free, 0);
      assert.equal(recovered.stats.newQ, 4);
      for (const index of erased) assert.equal(recovered.known.get(index), 0);
    } else {
      assert.equal(recovered.stats.free, 8);
      for (const index of erased)
        assert.equal(recovered.known.has(index), false, 'free bits must remain unknown');
    }
  }
});

test('a corrupted stored original CRC fails rather than being regenerated', () => {
  const { data, observation, candidate } = bodyFixture();
  data[128 + 22] ^= 1;
  assert.throws(() => completeStream(data, observation, candidate), /bad original CRC/);
});

function lacingFixture() {
  const fixture = bodyFixture([new Uint8Array(3), new Uint8Array(5)]);
  const cells = [128 + 27, 128 + 28];
  const values = [0xa5, 0x5a];
  cells.forEach((index, n) => {
    fixture.data[index] ^= values[n];
  });
  fixture.observation.known = fixture.observation.known.filter(([index]) => !cells.includes(index));
  fixture.observation.lacingDomains = [
    [cells[0], [fixture.data[cells[0]] ^ 3, fixture.data[cells[0]] ^ 4]],
    [cells[1], [fixture.data[cells[1]] ^ 5, fixture.data[cells[1]] ^ 7]],
  ];
  return { ...fixture, cells, values };
}

test('the original page boundary selects the only feasible lacing sum', () => {
  const { data, observation, cells, values } = lacingFixture();
  const recovered = refineLacing(data, observation);
  const known = new Map(recovered.known);
  cells.forEach((index, n) => assert.equal(known.get(index), values[n]));
  assert.equal(recovered.lacingStats.newQ, 2);
});

test('contradictory lacing domains are rejected without changing the page boundary', () => {
  const { data, observation, cells } = lacingFixture();
  observation.lacingDomains = [
    [cells[0], [data[cells[0]] ^ 4]],
    [cells[1], [data[cells[1]] ^ 7]],
  ];
  assert.throws(
    () => refineLacing(data, observation),
    (error) => error.code === 'file_only_unsupported',
  );
});

test('newly fixed stream bytes cannot be overwritten by stale lacing domains', () => {
  const { data, observation, cells, values } = lacingFixture();
  observation.known.push([cells[0], values[0]]);
  observation.lacingDomains[0][1] = [values[0] ^ 1];
  assert.throws(
    () => refineLacing(data, observation),
    (error) => error.code === 'file_only_unsupported',
  );
});
