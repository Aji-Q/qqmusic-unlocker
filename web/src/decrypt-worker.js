import { decryptFile } from './qmc.js';
self.onmessage = async ({ data: { bytes, name } }) => {
  try {
    if (!(bytes instanceof ArrayBuffer)) throw new Error('无法读取音乐文件');
    // Avoid constructing another full-size Blob copy of the transferred buffer.
    const file = {
      name, size: bytes.byteLength,
      slice(start, end) { return { arrayBuffer: async () => bytes.slice(start, end) }; },
    };
    const result = await decryptFile(file, value => self.postMessage({ progress: value }));
    self.postMessage({ result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ error: { message: error.message, code: error.code, hint: error.hint } });
  }
};
