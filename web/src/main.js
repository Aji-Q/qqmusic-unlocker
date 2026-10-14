import './style.css';
import { abortable } from './abortable.js';

const $ = id => document.getElementById(id);
const MAX_FILE = 100 * 1024 * 1024, MAX_TOTAL = 200 * 1024 * 1024, MAX_COUNT = 20;
let items = [], busy = false, controller = null, nextId = 0;
const size = n => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;
const mime = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

try {
  const saved = JSON.parse(localStorage.getItem('qqmusic-web-preferences'));
  if (['mp3', 'original'].includes(saved?.format)) $('format').value = saved.format;
  if (['128', '192', '256', '320'].includes(saved?.bitrate)) $('bitrate').value = saved.bitrate;
} catch { /* Preferences are optional in private browsing. */ }
function settingsChanged() {
  $('bitrateField').hidden = $('format').value !== 'mp3';
  $('formatHint').textContent = $('format').value === 'mp3' ? '兼容常用播放器 · 可调整码率。' : '解密后直接保存，不再次压缩。';
  try { localStorage.setItem('qqmusic-web-preferences', JSON.stringify({ format: $('format').value, bitrate: $('bitrate').value })); } catch { /* No persistence required. */ }
}
$('format').addEventListener('change', settingsChanged);
$('bitrate').addEventListener('change', settingsChanged);
settingsChanged();

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
}
function textElement(tag, className, text) {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function render() {
  const focused = document.activeElement?.dataset?.focus;
  $('count').textContent = items.length;
  $('queue').hidden = !items.length; $('empty').hidden = !!items.length;
  const pending = items.filter(i => i.state === 'pending').length;
  const complete = items.filter(i => i.state === 'done').length;
  const failed = items.filter(i => i.state === 'error').length;
  $('start').disabled = busy || !pending;
  $('start').innerHTML = complete || failed ? '继续转换 <span aria-hidden="true">→</span>' : '开始转换 <span aria-hidden="true">→</span>';
  $('clear').disabled = busy || !items.length;
  $('cancel').hidden = !busy;
  $('retry').hidden = busy || !failed;
  $('format').disabled = busy; $('bitrate').disabled = busy;
  $('summary').textContent = busy ? `正在处理 · 已完成 ${complete} / ${items.length}` : items.length ? [complete && `完成 ${complete}`, failed && `失败 ${failed}`, pending && `待处理 ${pending}`].filter(Boolean).join(' · ') : '等待选择文件';
  $('substatus').textContent = complete ? '请点击文件旁的下载按钮，关闭页面前保存结果。' : '转换完成后，文件仅保留在当前页面。';
  const rows = items.map(item => {
    const row = textElement('li', 'queueItem', ''); row.dataset.id = item.id;
    const icon = textElement('span', 'fileIcon', '♪'); icon.setAttribute('aria-hidden', 'true'); row.append(icon);
    const content = textElement('div', 'fileContent', '');
    content.append(textElement('p', 'fileName', item.file.name));
    const meta = textElement('p', 'fileMeta', size(item.file.size));
    meta.append(textElement('span', 'fileStatus', item.label)); content.append(meta);
    if (item.state === 'working') {
      const progress = textElement('div', 'fileProgress', '');
      const fill = document.createElement('span'); fill.style.width = `${item.progress == null ? 18 : Math.round(item.progress * 100)}%`; progress.append(fill); content.append(progress);
    }
    if (item.error) {
      const error = textElement('p', 'fileError', item.error);
      content.append(error);
    }
    const actions = textElement('div', 'actions', '');
    if (item.url) {
      const download = textElement('a', 'button small download', item.downloaded ? '再次下载 ↓' : `下载 ${item.extension.slice(1).toUpperCase()} ↓`);
      download.href = item.url; download.download = item.outputName; download.dataset.focus = `download-${item.id}`;
      download.addEventListener('click', () => { item.downloaded = true; download.textContent = '再次下载 ↓'; }); actions.append(download);
    }
    const remove = textElement('button', 'quiet small', '移除'); remove.disabled = busy; remove.dataset.focus = `remove-${item.id}`;
    remove.setAttribute('aria-label', `移除 ${item.file.name}`);
    remove.addEventListener('click', () => { if (item.url) URL.revokeObjectURL(item.url); items = items.filter(i => i.id !== item.id); render(); }); actions.append(remove);
    row.append(content, actions); return row;
  });
  $('queue').replaceChildren(...rows);
  if (focused) document.querySelector(`[data-focus="${focused}"]`)?.focus({ preventScroll: true });
}
function updateProgress(item, label, progress) {
  item.label = label; item.progress = progress;
  const row = document.querySelector(`[data-id="${item.id}"]`);
  if (row) { row.querySelector('.fileStatus').textContent = label + (progress == null ? '' : ` · ${Math.round(progress * 100)}%`); row.querySelector('.fileProgress span').style.width = `${progress == null ? 18 : progress * 100}%`; }
}
function addFiles(files) {
  let added = 0, skipped = 0, limited = 0;
  let total = items.reduce((sum, i) => sum + i.file.size, 0);
  for (const file of files) {
    if (items.some(i => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) { skipped++; continue; }
    if (file.size > MAX_FILE || total + file.size > MAX_TOTAL || items.length >= MAX_COUNT) { limited++; continue; }
    items.push({ id: ++nextId, file, state: 'pending', label: '等待转换', progress: 0 }); total += file.size; added++;
  }
  notice([added && `已添加 ${added} 个文件`, skipped && `已跳过 ${skipped} 个重复文件`, limited && `${limited} 个文件超出限制：单个 100 MB，每批 200 MB / 20 个`].filter(Boolean).join('；'), !!limited);
  if (!files.length) notice('没有读取到文件。请点击「选择文件」，文件夹请先打开后选择其中的音频。', true);
  render();
  if (added && !busy) $('start').focus();
}
$('choose').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', () => { addFiles([...$('files').files]); $('files').value = ''; });
let dragDepth = 0;
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
$('dropzone').addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('dropzone').classList.add('hot'); });
$('dropzone').addEventListener('dragleave', () => { if (--dragDepth <= 0) $('dropzone').classList.remove('hot'); });
$('dropzone').addEventListener('drop', e => { dragDepth = 0; $('dropzone').classList.remove('hot'); addFiles([...e.dataTransfer.files]); });

function decrypt(file, signal, progress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./decrypt-worker.js', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort); clearTimeout(timer); };
    const abort = () => { cleanup(); reject(new DOMException('已停止', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('文件处理超时，请尝试桌面版。')); }, 180000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if ('progress' in data) { progress(data.progress); return; }
      cleanup();
      if (data.error) reject(Object.assign(new Error(data.error.message), data.error)); else resolve(data.result);
    };
    worker.onerror = () => { cleanup(); reject(new Error('文件处理组件无法启动，请刷新页面后重试。')); };
    if (signal.aborted) abort(); else worker.postMessage(file);
  });
}
function saveResult(item, bytes, extension, name) {
  const stored = items.reduce((sum, i) => sum + (i === item ? 0 : (i.outputSize || 0)), 0);
  if (stored + bytes.byteLength > MAX_TOTAL) return false;
  if (item.url) URL.revokeObjectURL(item.url);
  item.url = URL.createObjectURL(new Blob([bytes], { type: mime[extension] || 'application/octet-stream' }));
  item.extension = extension; item.outputSize = bytes.byteLength;
  const baseName = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || '音频';
  let outputName = baseName + extension, suffix = 2;
  while (items.some(i => i !== item && i.outputName === outputName)) outputName = `${baseName} (${suffix++})${extension}`;
  item.outputName = outputName;
  return true;
}
async function start() {
  if (busy || !items.some(i => i.state === 'pending')) return;
  busy = true; controller = new AbortController(); const signal = controller.signal;
  const format = $('format').value, bitrate = $('bitrate').value;
  notice(''); render();
  try {
    for (;;) {
      if (signal.aborted) break;
      const item = items.find(i => i.state === 'pending'); if (!item) break;
      item.state = 'working'; item.label = '读取文件'; item.progress = 0; item.error = ''; render();
      let decoded;
      try {
        decoded = await decrypt(item.file, signal, p => updateProgress(item, '读取与解密', p));
        signal.throwIfAborted();
        let bytes = decoded.data, extension = decoded.extension;
        if (format === 'mp3') {
          updateProgress(item, '加载转换组件', null);
          const { transcode } = await abortable(import('./transcode.js'), signal, { timeoutMs: 30000 });
          bytes = await transcode(bytes, extension, bitrate, (label, p) => updateProgress(item, label, p), signal, Math.min(MAX_FILE, MAX_TOTAL - items.reduce((sum, i) => sum + (i.outputSize || 0), 0)));
          extension = '.mp3';
        }
        signal.throwIfAborted();
        if (!saveResult(item, bytes, extension, decoded.name)) throw new Error('结果总量超过 200 MB，请移除已下载项后重试。');
        item.state = 'done'; item.label = `完成 · ${extension.slice(1).toUpperCase()} · ${size(bytes.length)}`;
      } catch (error) {
        if (signal.aborted) { item.state = 'pending'; item.label = '已停止 · 可继续'; break; }
        const retained = decoded && saveResult(item, decoded.data, decoded.extension, decoded.name);
        item.state = 'error'; item.label = retained ? 'MP3 未完成 · 可下载原格式' : '未完成'; item.code = error.code;
        item.error = /[\u4e00-\u9fff]/.test(error.message || '') ? error.message : '转换组件加载失败，请检查网络后重试。原格式可直接下载。';
        if (decoded && !retained) item.error += ' 结果总量已达限制，请移除已下载项后重试。';
        if (error.hint && !item.error.includes(error.hint)) item.error += ` ${error.hint}`;
      }
      render();
    }
  } finally { busy = false; controller = null; render(); }
}
$('start').addEventListener('click', start);
$('cancel').addEventListener('click', () => controller?.abort());
$('retry').addEventListener('click', () => { items.forEach(i => { if (i.state === 'error') { if (i.url) URL.revokeObjectURL(i.url); i.url = null; i.outputSize = 0; i.downloaded = false; i.state = 'pending'; i.label = '等待重试'; i.error = ''; } }); start(); });
$('clear').addEventListener('click', () => { items.forEach(i => { if (i.url) URL.revokeObjectURL(i.url); }); items = []; notice(''); render(); });
let helpTrigger;
function help(event) { helpTrigger = event.currentTarget; $('help').showModal(); }
$('help').addEventListener('close', () => helpTrigger?.focus());
$('helpOpen').addEventListener('click', help); $('where').addEventListener('click', help);
$('helpClose').addEventListener('click', () => $('help').close());
$('help').addEventListener('click', e => { if (e.target === $('help')) { const b = $('help').getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) $('help').close(); } });
window.addEventListener('beforeunload', e => { if (busy || items.some(i => i.url && !i.downloaded)) { e.preventDefault(); e.returnValue = ''; } });
if (!window.Worker || !window.WebAssembly) { $('choose').disabled = true; notice('此浏览器缺少文件处理组件，请使用最新版 Chrome、Edge 或 Safari。', true); }
render();
