import { Input, FLAC, OGG, WAVE, MP3, BlobSource, Output, StreamTarget, Mp3OutputFormat, canEncodeAudio, Conversion, Quality } from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { abortable } from './abortable.js';

let encoderReady;
async function initEncoder() {
  return encoderReady ??= (async () => {
    if (!(await canEncodeAudio('mp3'))) registerMp3Encoder();
  })();
}

export async function transcode(data, extension, bitrate, onStatus, signal, maxOutputBytes = 100 * 1024 * 1024) {
  signal.throwIfAborted();
  let input, conversion, stopped = false;
  const stop = () => {
    stopped = true;
    void conversion?.cancel().catch(() => {});
    input?.dispose();
  };
  const check = () => { signal.throwIfAborted(); if (stopped) throw new Error('转换已停止，请重试。'); };
  const run = async () => {
    onStatus('准备转码器', null);
    await initEncoder(); check();
    input = new Input({ source: new BlobSource(new Blob([data])), formats: [FLAC, OGG, WAVE, MP3] });
    const track = await input.getPrimaryAudioTrack(); check();
    if (!track) throw new Error('没有找到音轨，请确认文件已下载完成。');
    const duration = await track.computeDuration(); check();
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确认音频时长，请下载原格式或使用桌面版。');
    if ((duration + 1) * Number(bitrate) * 1000 / 8 > maxOutputBytes - 65536) {
      throw new Error('预计输出超出本页内存限制。请移除已完成项、降低码率，或下载原格式。');
    }
    if (!(await track.canDecode())) throw new Error('当前浏览器无法解码此音频。请下载原格式，或使用最新版 Chrome / Edge、桌面版。');
    check();
    const sourceRate = await track.getSampleRate(); check();
    const numberOfChannels = Math.min(await track.getNumberOfChannels(), 2); check();
    const sampleRate = sourceRate > 48000 ? (sourceRate % 44100 === 0 ? 44100 : 48000) : sourceRate < 32000 ? 44100 : sourceRate;
    const chunks = []; let length = 0, written = 0;
    const target = new StreamTarget(new WritableStream({
      write({ data: chunk, position }) {
        check();
        written += chunk.byteLength;
        if (position + chunk.byteLength > maxOutputBytes || written > maxOutputBytes + 65536) {
          throw new Error('输出文件超出本页内存限制，请下载原格式或使用桌面版。');
        }
        chunks.push({ bytes: chunk.slice(), position });
        length = Math.max(length, position + chunk.byteLength);
      }
    }), { chunked: true, chunkSize: 65536 });
    const output = new Output({ format: new Mp3OutputFormat(), target });
    conversion = await Conversion.init({ input, output, tracks: 'primary', audio: { codec: 'mp3', quality: new Quality({ bitrate: Number(bitrate) * 1000 }), forceTranscode: true, sampleRate, numberOfChannels }, video: { discard: true } });
    check();
    if (!conversion.isValid) throw new Error('无法转换此音频，请下载原格式或使用桌面版。');
    onStatus('转为 MP3', 0);
    conversion.onProgress = value => { if (!stopped) onStatus('转为 MP3', Math.max(0, Math.min(.99, value))); };
    await conversion.execute(); check();
    if (!length) throw new Error('没有生成音频，请重新下载源文件后再试。');
    const result = new Uint8Array(length);
    for (const chunk of chunks) result.set(chunk.bytes, chunk.position);
    return result;
  };
  try {
    return await abortable(run(), signal, { timeoutMs: 300000, onAbort: stop });
  } catch (error) {
    signal.throwIfAborted();
    if (error.name === 'EncodingError' || !/[\u4e00-\u9fff]/.test(error.message || '')) {
      throw new Error('此浏览器无法完成 MP3 转换。可下载原格式，或改用最新版 Chrome / Edge、桌面版。');
    }
    throw error;
  } finally { stop(); }
}
