import { decryptFile } from './qmc.js';
self.onmessage = async ({ data: file }) => {
  try {
    const result = await decryptFile(file, value => self.postMessage({ progress: value }));
    self.postMessage({ result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ error: { message: error.message, code: error.code, hint: error.hint } });
  }
};
