// Native FLAC structure and ORIGINAL checksum verification (RFC 9639).
// This parses encoded subframes to locate the footer; it does not synthesize
// headers, repair checksums, decode PCM, or claim to verify the PCM MD5.
const MAX_BYTES = 100 * 1024 * 1024;
const CRC8 = Uint8Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i += 1) n = ((n << 1) ^ ((n & 128) ? 7 : 0)) & 255;
  return n;
});
const CRC16 = Uint16Array.from({ length: 256 }, (_, n) => {
  n <<= 8;
  for (let i = 0; i < 8; i += 1) n = ((n << 1) ^ ((n & 32768) ? 0x8005 : 0)) & 65535;
  return n;
});
const SAMPLE_RATES = [null, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const BIT_DEPTHS = [null, 8, 12, null, 16, 20, 24, 32];

function unsupported() {
  const error = new Error('无法验证完整的 FLAC 音频');
  error.code = 'file_only_unsupported';
  throw error;
}

function uint24(data, offset) {
  return data[offset] * 65536 + data[offset + 1] * 256 + data[offset + 2];
}

/** Parse a checksum-valid frame header, or return null. Metadata is optional. */
export function parseFlacHeader(data, offset = 0, streamInfo = null) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 6 > data.length
      || data[offset] !== 255 || (data[offset + 1] & 254) !== 248) return null;
  const variable = Boolean(data[offset + 1] & 1);
  const blockCode = data[offset + 2] >>> 4;
  const rateCode = data[offset + 2] & 15;
  const channel = data[offset + 3] >>> 4;
  const depthCode = (data[offset + 3] >>> 1) & 7;
  if (!blockCode || rateCode === 15 || channel > 10 || depthCode === 3 || (data[offset + 3] & 1)) return null;
  let cursor = offset + 4;
  const first = data[cursor++];
  let length = 1;
  let number = first;
  if (first >= 128) {
    length = 0;
    for (let mask = 128; first & mask; mask >>>= 1) length += 1;
    if (length < 2 || length > (variable ? 7 : 6) || cursor + length - 1 >= data.length) return null;
    number = first & (127 >>> length);
    for (let i = 1; i < length; i += 1) {
      const byte = data[cursor++];
      if ((byte & 192) !== 128) return null;
      number = number * 64 + (byte & 63);
    }
    const minimum = [0, 0, 128, 2048, 65536, 2097152, 67108864, 2147483648][length];
    if (number < minimum) return null;
  }
  if (number > (variable ? 0xfffffffff : 0x7fffffff)) return null;
  let samples = blockCode === 1 ? 192 : blockCode <= 5 ? 144 * (2 ** blockCode) : 2 ** blockCode;
  if (blockCode === 6) {
    if (cursor >= data.length) return null;
    samples = data[cursor++] + 1;
  } else if (blockCode === 7) {
    if (cursor + 2 > data.length) return null;
    samples = data[cursor] * 256 + data[cursor + 1] + 1;
    cursor += 2;
  }
  if (samples > 65535) return null;
  let sampleRate = rateCode === 0 ? streamInfo?.sampleRate ?? null : SAMPLE_RATES[rateCode];
  if (rateCode === 12) {
    if (cursor >= data.length) return null;
    sampleRate = data[cursor++] * 1000;
  } else if (rateCode === 13 || rateCode === 14) {
    if (cursor + 2 > data.length) return null;
    sampleRate = (data[cursor] * 256 + data[cursor + 1]) * (rateCode === 14 ? 10 : 1);
    cursor += 2;
  }
  if (sampleRate === 0 || cursor >= data.length) return null;
  let crc = 0;
  for (let i = offset; i < cursor; i += 1) crc = CRC8[crc ^ data[i]];
  if (crc !== data[cursor++]) return null;
  return {
    number, frameNumber: variable ? null : number, sampleNumber: variable ? number : null,
    variable, blockCode, rateCode, channel, depthCode, headerLength: cursor - offset,
    samples, sampleRate, channels: channel <= 7 ? channel + 1 : 2,
    bitsPerSample: depthCode === 0 ? streamInfo?.bitsPerSample ?? null : BIT_DEPTHS[depthCode],
  };
}

/** Read original metadata. Zero total samples is valid FLAC but unsuitable for recovery verification. */
export function parseFlacMetadata(data) {
  if (!(data instanceof Uint8Array) || data.length < 42 || data.length > MAX_BYTES
      || data[0] !== 102 || data[1] !== 76 || data[2] !== 97 || data[3] !== 67) unsupported();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 4;
  let streamInfo;
  let last = false;
  const singletons = new Set();
  while (!last) {
    if (offset + 4 > data.length) unsupported();
    last = Boolean(data[offset] & 128);
    const type = data[offset] & 127;
    const size = uint24(data, offset + 1);
    const start = offset + 4;
    const end = start + size;
    if (type === 127 || end > data.length || (!streamInfo && type !== 0)) unsupported();
    if ([0, 3, 4, 5].includes(type)) {
      if (singletons.has(type)) unsupported();
      singletons.add(type);
    }
    if (type === 0) {
      if (size !== 34) unsupported();
      const packed = view.getBigUint64(start + 10);
      streamInfo = {
        minBlockSize: view.getUint16(start), maxBlockSize: view.getUint16(start + 2),
        minFrameSize: uint24(data, start + 4), maxFrameSize: uint24(data, start + 7),
        sampleRate: Number(packed >> 44n), channels: Number((packed >> 41n) & 7n) + 1,
        bitsPerSample: Number((packed >> 36n) & 31n) + 1,
        totalSamples: Number(packed & 0xfffffffffn), md5: data.subarray(start + 18, end),
      };
      if (streamInfo.minBlockSize < 16 || streamInfo.maxBlockSize < streamInfo.minBlockSize
          || !streamInfo.sampleRate || streamInfo.bitsPerSample < 4
          || (streamInfo.minFrameSize && streamInfo.maxFrameSize && streamInfo.minFrameSize > streamInfo.maxFrameSize)) unsupported();
    } else if (type === 1) {
      for (let i = start; i < end; i += 1) if (data[i] !== 0) unsupported();
    } else if (type === 2 && size < 4) unsupported();
    else if (type === 3) {
      if (size % 18 !== 0) unsupported();
      let previous = -1n;
      for (let i = start; i < end; i += 18) {
        const sample = view.getBigUint64(i);
        if (sample !== 0xffffffffffffffffn && sample <= previous) unsupported();
        previous = sample;
      }
    } else if (type === 4) {
      // Lengths are little endian only in Vorbis comments.
      let cursor = start;
      const readLength = () => {
        if (cursor + 4 > end) unsupported();
        const value = view.getUint32(cursor, true);
        cursor += 4;
        return value;
      };
      const vendorLength = readLength();
      cursor += vendorLength;
      const count = readLength();
      if (count > (end - cursor) / 4) unsupported();
      for (let i = 0; i < count; i += 1) {
        const length = readLength();
        cursor += length;
      }
      if (cursor !== end) unsupported();
    }
    offset = end;
  }
  return { ...streamInfo, audioOffset: offset };
}

// Read encoded lengths without allocating PCM. Every loop advances in the
// input or in a bounded (<=65535) block; truncated/unbounded unary codes fail.
function frameEnd(data, start, header) {
  let position = (start + header.headerLength) * 8;
  const limit = data.length * 8;
  const skip = (count) => {
    if (count < 0 || position + count > limit) unsupported();
    position += count;
  };
  const read = (count) => {
    if (position + count > limit) unsupported();
    let value = 0;
    while (count > 0) {
      const take = Math.min(count, 8 - (position & 7));
      value = value * (2 ** take) + ((data[position >>> 3] >>> (8 - (position & 7) - take)) & ((1 << take) - 1));
      position += take;
      count -= take;
    }
    return value;
  };
  const unary = () => {
    let zeros = 0;
    while (position < limit) {
      const bits = 8 - (position & 7);
      const byte = data[position >>> 3] & ((1 << bits) - 1);
      if (byte) {
        const n = bits - (32 - Math.clz32(byte));
        position += n + 1;
        return zeros + n;
      }
      zeros += bits;
      position += bits;
    }
    unsupported();
  };
  const residual = (order) => {
    const method = read(2);
    if (method > 1) unsupported();
    const riceBits = method + 4;
    const partitions = 2 ** read(4);
    if (header.samples % partitions || header.samples / partitions <= order) unsupported();
    const partitionSamples = header.samples / partitions;
    for (let partition = 0; partition < partitions; partition += 1) {
      const count = partitionSamples - (partition === 0 ? order : 0);
      const parameter = read(riceBits);
      if (parameter === (1 << riceBits) - 1) skip(count * read(5));
      else {
        for (let sample = 0; sample < count; sample += 1) {
          const quotient = unary();
          // Folded residuals must fit the specified signed-32-bit range.
          if (quotient * (2 ** parameter) + read(parameter) > 0xfffffffe) unsupported();
        }
      }
    }
  };
  for (let channel = 0; channel < header.channels; channel += 1) {
    let bits = header.bitsPerSample;
    if ((header.channel === 8 && channel === 1) || (header.channel === 9 && channel === 0)
        || (header.channel === 10 && channel === 1)) bits += 1;
    if (read(1)) unsupported();
    const type = read(6);
    if (read(1)) bits -= unary() + 1;
    if (bits < 1) unsupported();
    if (type === 0) skip(bits);
    else if (type === 1) skip(bits * header.samples);
    else if (type >= 8 && type <= 12) {
      const order = type - 8;
      if (order > header.samples) unsupported();
      skip(bits * order);
      residual(order);
    } else if (type >= 32) {
      const order = type - 31;
      if (order > header.samples) unsupported();
      skip(bits * order);
      const precision = read(4) + 1;
      if (precision === 16 || read(5) >= 16) unsupported();
      skip(order * precision);
      residual(order);
    } else unsupported();
  }
  if ((position & 7) && read(8 - (position & 7)) !== 0) unsupported();
  skip(16);
  return position / 8;
}

/**
 * Verify original metadata, encoded frame boundaries, every original CRC8 and
 * CRC16, stable audio parameters and exact STREAMINFO sample total. Return a
 * view of the unchanged FLAC. MusicEx may append <=15 non-audio bytes; these are
 * removed ONLY after the exact last frame has been parsed and authenticated.
 * This is an integrity gate, not a PCM decoder or an MD5 verification routine.
 */
export function verifyRecoveredFlac(data) {
  const info = parseFlacMetadata(data);
  if (!info.totalSamples) unsupported();
  let offset = info.audioOffset;
  let samples = 0;
  let frames = 0;
  let variable;
  let fixedBlockSize;
  while (samples < info.totalSamples) {
    const header = parseFlacHeader(data, offset, info);
    if (!header || header.number !== (header.variable ? samples : frames)
        || header.sampleRate !== info.sampleRate || header.channels !== info.channels
        || header.bitsPerSample !== info.bitsPerSample || header.samples > info.maxBlockSize
        || (variable !== undefined && header.variable !== variable)) unsupported();
    variable = header.variable;
    const nextSamples = samples + header.samples;
    if (nextSamples > info.totalSamples || (nextSamples < info.totalSamples && header.samples < info.minBlockSize)) unsupported();
    if (!variable) {
      fixedBlockSize ??= header.samples;
      if ((nextSamples < info.totalSamples && header.samples !== fixedBlockSize)
          || header.samples > fixedBlockSize) unsupported();
    }
    const end = frameEnd(data, offset, header);
    const length = end - offset;
    if ((info.minFrameSize && length < info.minFrameSize) || (info.maxFrameSize && length > info.maxFrameSize)) unsupported();
    let crc = 0;
    for (let i = offset; i < end; i += 1) crc = ((crc << 8) ^ CRC16[(crc >>> 8) ^ data[i]]) & 65535;
    if (crc !== 0) unsupported();
    offset = end;
    samples = nextSamples;
    frames += 1;
  }
  if (!frames || data.length - offset > 15) unsupported();
  return data.subarray(0, offset);
}
