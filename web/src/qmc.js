/** Local QMC2 decryption. No network or account credentials are used here. */

const DELTA = 0x9e3779b9;
const MAX_KEY_BYTES = 16 * 1024;
const CHUNK_SIZE = 512 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENCV2_PREFIX = encoder.encode('QQMusic EncV2,Key:');
const ENCV2_KEYS = ['386ZJY!@#*$%^&)(', '**#!(#$%&^a1cZ,T'].map((s) => encoder.encode(s));
const ENCRYPTED_EXTENSIONS = new Set([
  'mgg', 'mgg1', 'mggl', 'mflac', 'mflac0', 'mflac1',
  'qmcogg', 'qmcflac', 'qmc0', 'qmc2', 'qmc3',
]);

export class QmcError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'QmcError';
    this.code = code;
    this.hint = hint;
  }
}

function fail(code, message, hint) {
  throw new QmcError(code, message, hint);
}

function startsWith(data, prefix) {
  const bytes = typeof prefix === 'string' ? encoder.encode(prefix) : prefix;
  return data.length >= bytes.length && bytes.every((byte, i) => byte === data[i]);
}

function littleUint32(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function base64Decode(value) {
  // A partial key is never silently accepted. Whitespace and omitted padding
  // occur in older files and are safe to normalize.
  const normalized = value.trim().replace(/^\0+|\0+$/g, '').replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
      || normalized.replace(/=+$/, '').length % 4 === 1
      || (normalized.includes('=') && normalized.length % 4 !== 0)) {
    fail('invalid_key', '文件中的解密信息无法识别', '请重新下载文件，或使用桌面版。');
  }
  try {
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    fail('invalid_key', '文件中的解密信息无法识别', '请重新下载文件，或使用桌面版。');
  }
}

function ecbRound(value, sum, key1, key2) {
  return ((((value << 4) >>> 0) + key1) ^ ((sum + value) >>> 0)
    ^ ((value >>> 5) + key2)) >>> 0;
}

function decryptBlock(left, right, key) {
  let sum = Math.imul(DELTA, 16) >>> 0;
  for (let round = 0; round < 16; round += 1) {
    right = (right - ecbRound(left, sum, key[2], key[3])) >>> 0;
    left = (left - ecbRound(right, sum, key[0], key[1])) >>> 0;
    sum = (sum - DELTA) >>> 0;
  }
  return [left, right];
}

/** Tencent's 16-round TEA CBC variant; invalid padding returns null. */
export function teaDecrypt(data, key) {
  if (key.length !== 16 || data.length < 10 || data.length % 8 !== 0) return null;
  const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const words = [0, 4, 8, 12].map((offset) => keyView.getUint32(offset));
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const output = new Uint8Array(data.length);
  const target = new DataView(output.buffer);
  let previousCipher = [0, 0];
  let previousBlock = [0, 0];
  for (let offset = 0; offset < data.length; offset += 8) {
    const cipher = [source.getUint32(offset), source.getUint32(offset + 4)];
    const next = decryptBlock(
      (cipher[0] ^ previousBlock[0]) >>> 0,
      (cipher[1] ^ previousBlock[1]) >>> 0,
      words,
    );
    target.setUint32(offset, (next[0] ^ previousCipher[0]) >>> 0);
    target.setUint32(offset + 4, (next[1] ^ previousCipher[1]) >>> 0);
    previousCipher = cipher;
    previousBlock = next;
  }
  const start = 1 + (output[0] & 7) + 2;
  const end = output.length - 7;
  if (end < start || output.subarray(end).some((byte) => byte !== 0)) return null;
  return output.slice(start, end);
}

function deriveTeaKey(header) {
  const key = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    key[index * 2] = Math.trunc(100 * Math.abs(Math.tan(106 + index * 0.1))) & 0xff;
    key[index * 2 + 1] = header[index];
  }
  return key;
}

/** Decode the same legacy and EncV2 embedded keys as the desktop engine. */
export function parseEkey(ekey) {
  let decoded = base64Decode(ekey);
  if (startsWith(decoded, ENCV2_PREFIX)) {
    const first = teaDecrypt(decoded.subarray(ENCV2_PREFIX.length), ENCV2_KEYS[0]);
    const second = first && teaDecrypt(first, ENCV2_KEYS[1]);
    if (!second?.length) {
      fail('invalid_key', '暂不支持此文件的加密方式', '请尝试桌面版。');
    }
    decoded = base64Decode(decoder.decode(second));
  }
  if (decoded.length < 8) {
    fail('invalid_key', '文件中的解密信息不完整', '请重新下载文件。');
  }
  const header = decoded.subarray(0, 8);
  if (decoded.length === 8) return decoded;
  const plain = teaDecrypt(decoded.subarray(8), deriveTeaKey(header));
  // Older raw keys have no TEA wrapping. This fallback is intentional and
  // matches app/qmengine.py; the decrypted audio signature is checked later.
  if (plain === null) return decoded;
  const result = new Uint8Array(header.length + plain.length);
  result.set(header);
  result.set(plain, header.length);
  return result;
}

export class MapCipher {
  constructor(key) {
    if (!key.length) fail('invalid_key', '文件缺少解密信息');
    this.key = key;
  }

  decrypt(offset, bytes) {
    const { key } = this;
    for (let index = 0; index < bytes.length; index += 1) {
      const position = offset + index;
      const mapped = position > 0x7fff ? position % 0x7fff : position;
      const keyIndex = (mapped * mapped + 71214) % key.length;
      const rotation = (keyIndex + 4) & 7;
      const value = key[keyIndex];
      // QMC uses this particular shift, not a conventional bit rotation.
      const mask = rotation === 0 ? value : ((value << rotation) & 0xff) | (value >>> rotation);
      bytes[index] ^= mask;
    }
  }
}

export class Rc4Cipher {
  constructor(key) {
    if (!key.length) fail('invalid_key', '文件缺少解密信息');
    this.key = key;
    this.state = Array.from({ length: key.length }, (_, index) => index & 0xff);
    let index2 = 0;
    for (let index = 0; index < key.length; index += 1) {
      index2 = (index2 + this.state[index] + key[index]) % key.length;
      [this.state[index], this.state[index2]] = [this.state[index2], this.state[index]];
    }
    this.hash = 1;
    for (const value of key) {
      if (!value) continue;
      const next = (this.hash * value) >>> 0;
      if (!next || next <= this.hash) break;
      this.hash = next;
    }
  }

  segmentKey(segment, seed) {
    return seed ? Math.trunc((this.hash / ((segment + 1) * seed)) * 100) : 0;
  }

  decrypt(offset, bytes) {
    const { key } = this;
    const length = key.length;
    let index = 0;
    let position = offset;
    while (position < 0x80 && index < bytes.length) {
      bytes[index] ^= key[this.segmentKey(position, key[position % length]) % length];
      index += 1;
      position += 1;
    }
    while (index < bytes.length) {
      const segment = Math.floor(position / 0x1400);
      const alignment = position % 0x1400;
      const count = Math.min(bytes.length - index, 0x1400 - alignment);
      const seed = key[(segment & 0x1ff) % length];
      const discard = (this.segmentKey(segment, seed) & 0x1ff) + alignment;
      const state = this.state.slice();
      let index1 = 0;
      let index2 = 0;
      for (let step = 0; step < discard + count; step += 1) {
        index1 = (index1 + 1) % length;
        index2 = (state[index1] + index2) % length;
        [state[index1], state[index2]] = [state[index2], state[index1]];
        if (step >= discard) {
          bytes[index + step - discard] ^= state[(state[index1] + state[index2]) % length];
        }
      }
      index += count;
      position += count;
    }
  }
}

export function makeCipher(key) {
  return key.length > 300 ? new Rc4Cipher(key) : new MapCipher(key);
}

/** Recognize a container by its bytes, never merely its filename. */
export function audioExtension(data) {
  if (startsWith(data, 'fLaC')) return '.flac';
  if (startsWith(data, 'OggS')) return '.ogg';
  if (startsWith(data, 'RIFF') && startsWith(data.subarray(8), 'WAVE')) return '.wav';
  if (startsWith(data, 'ID3')) return '.mp3';
  if (data.length >= 4 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0
      && (data[1] & 0x18) !== 0x08 && (data[1] & 0x06) !== 0
      && (data[2] & 0xf0) !== 0xf0 && (data[2] & 0xf0) !== 0
      && (data[2] & 0x0c) !== 0x0c) return '.mp3';
  return null;
}

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Read only the footer/key before allocating the full audio body. */
async function embeddedKey(file) {
  const tail = await readBytes(file, Math.max(0, file.size - 16), file.size);
  const size = file.size;
  if (tail.length >= 16 && startsWith(tail.subarray(tail.length - 8), 'musicex\0')) {
    const footerLength = littleUint32(tail, tail.length - 16);
    if (footerLength < 16 || footerLength >= size) {
      fail('invalid_footer', '文件的尾部信息不完整', '请重新下载文件。');
    }
    fail('needs_desktop', '此文件需要桌面版', '网页无法读取 QQ 音乐登录，请在桌面版中转换。');
  }
  const tagged = tail.length >= 8 && startsWith(tail.subarray(tail.length - 4), 'QTag');
  const suffixLength = tagged ? 8 : 4;
  if (tail.length < suffixLength) {
    fail('missing_key', '文件中没有可用的解密信息', '请尝试桌面版，或重新下载文件。');
  }
  // QTag uses network byte order; only untagged V1 uses little-endian.
  const keyLength = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    .getUint32(tail.length - suffixLength, !tagged);
  if (!keyLength || keyLength >= size - suffixLength || keyLength > MAX_KEY_BYTES) {
    fail(tagged ? 'invalid_footer' : 'missing_key', tagged
      ? '文件的尾部信息不完整' : '文件中没有可用的解密信息', '请尝试桌面版，或重新下载文件。');
  }
  const bodyEnd = size - suffixLength - keyLength;
  const keyBytes = await readBytes(file, bodyEnd, bodyEnd + keyLength);
  if (keyBytes.some((byte) => byte < 32 || byte >= 127)) {
    fail('invalid_key', '文件中的解密信息无法识别', '请重新下载文件，或使用桌面版。');
  }
  // Legacy QTag may append a song id and flags after the first comma.
  const ekey = decoder.decode(keyBytes).split(',', 1)[0];
  return { key: parseEkey(ekey), bodyEnd };
}

/**
 * @param {File|Blob} file Browser file; only this selected file is read.
 * @param {(fraction: number) => void} onProgress Values from 0 to 1.
 * @returns {Promise<{data: Uint8Array, extension: string, name: string, decrypted: boolean}>}
 */
export async function decryptFile(file, onProgress = () => {}) {
  if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size)) {
    fail('invalid_file', '请选择音频文件');
  }
  if (!file.size) fail('empty_file', '文件为空', '请选择已下载完成的音频文件。');
  const originalName = file.name || '音频';
  const name = originalName.replace(/\.[^.]+$/, '') || '音频';
  const header = await readBytes(file, 0, Math.min(32, file.size));
  const plainExtension = audioExtension(header);
  onProgress(0);
  if (plainExtension) {
    const data = await readBytes(file, 0, file.size);
    onProgress(1);
    return { data, extension: plainExtension, name, decrypted: false };
  }
  const filenameExtension = originalName.split('.').pop().toLowerCase();
  let footer;
  try {
    footer = await embeddedKey(file);
  } catch (error) {
    if (error.code === 'missing_key' && !ENCRYPTED_EXTENSIONS.has(filenameExtension)) {
      fail('unsupported_format', '无法识别此音频格式', '请选择 QMC、MFLAC、MGG 或 FLAC、OGG、WAV、MP3 文件。');
    }
    throw error;
  }
  const data = await readBytes(file, 0, footer.bodyEnd);
  const cipher = makeCipher(footer.key);
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, data.length);
    cipher.decrypt(offset, data.subarray(offset, end));
    if (offset === 0 && !['.flac', '.ogg'].includes(audioExtension(data.subarray(0, 32)))) {
      fail('decryption_failed', '无法解密此文件', '文件可能不完整或使用其他加密方式，请尝试桌面版。');
    }
    onProgress(end / data.length);
    if (end < data.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { data, extension: audioExtension(data.subarray(0, 32)), name, decrypted: true };
}
