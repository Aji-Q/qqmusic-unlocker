import createModule from './vendor/vorbis-validator.js';
const MAX_PACKET = 131072;

/** Build one isolated validator module. Pass wasmBinary in Node/tests, or
 * locateFile in browsers if the .wasm asset is served at another URL. */
export async function createValidatorFactory(options = {}) {
  const moduleOptions = { ...options };
  if (!moduleOptions.wasmBinary && !moduleOptions.locateFile) {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const moduleName = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ moduleName);
      moduleOptions.wasmBinary = await readFile(
        new URL('../scripts/vorbis-validator/artifacts/vorbis-validator.wasm', import.meta.url),
      );
    } else {
      moduleOptions.locateFile = () => '/vendor/vorbis-validator.wasm';
    }
  }
  const module = await createModule(moduleOptions);
  return function createValidator(headers) {
    if (!Array.isArray(headers) || headers.length !== 3)
      throw new Error('Three Vorbis headers required');
    const handle = module._qqv_create();
    const buffer = module._malloc(MAX_PACKET);
    let closed = false;
    if (!handle || !buffer) {
      if (handle) module._qqv_destroy(handle);
      if (buffer) module._free(buffer);
      throw new Error('Validator allocation failed');
    }
    const close = () => {
      if (closed) return;
      closed = true;
      module._qqv_destroy(handle);
      module._free(buffer);
    };
    const copy = (packet) => {
      if (!(packet instanceof Uint8Array) || !packet.length || packet.length > MAX_PACKET)
        throw new Error('Invalid Vorbis packet');
      module.HEAPU8.set(packet, buffer);
    };
    try {
      for (const header of headers) {
        copy(header);
        const status = module._qqv_header(handle, buffer, header.length);
        if (status) throw new Error(`Unsupported Vorbis profile (${status})`);
      }
      if (!module._qqv_ready(handle)) throw new Error('Validator setup incomplete');
    } catch (error) {
      close();
      throw error;
    }
    const id = new DataView(headers[0].buffer, headers[0].byteOffset, headers[0].byteLength);
    const profile = Object.freeze({
      channels: id.getUint8(11),
      rate: id.getUint32(12, true),
      bitrateUpper: id.getInt32(16, true),
      bitrateNominal: id.getInt32(20, true),
      bitrateLower: id.getInt32(24, true),
      modeBlockflags: Object.freeze([0, 1]),
    });
    const inspect = (packet) => {
      if (closed) throw new Error('Validator closed');
      copy(packet);
      const status = module._qqv_packet(handle, buffer, packet.length);
      return {
        valid: status === 0,
        status,
        consumed: module._qqv_consumed(handle),
        remaining: module._qqv_remaining(handle),
      };
    };
    return {
      profileOK: true,
      profile,
      /** Packet syntax is independent of previous packets; arbitrary subsets
       * and candidate variants can share this context. No PCM is returned. */
      inspect,
      validatePacket: (packet) => inspect(packet).valid,
      close,
      dispose: close,
    };
  };
}
