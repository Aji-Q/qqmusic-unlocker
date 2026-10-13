'use strict';

const TOKEN = '%%TOKEN%%';
const POLL_MS = 700;

const $ = (id) => document.getElementById(id);

let lastVersion = -1;
let HOME = '';
const rowNodes = new Map();

async function api(path, body) {
  const opt = { headers: { 'X-Token': TOKEN } };
  if (body !== undefined) {
    opt.method = 'POST';
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({ error: '响应解析失败' }));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function human(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function shortPath(p) {
  if (HOME && p.startsWith(HOME)) return '~' + p.slice(HOME.length);
  return p;
}

const FOOTER_LABEL = { musicex: 'musicex', QTag: 'QTag', V1: 'V1', unknown: '未知' };
const STATUS_CLASS = { '等待': 'wait', '进行中': 'run', '完成': 'ok', '失败': 'err' };

function buildRow(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="fname"><b></b><small></small></td>
    <td class="c-size"></td>
    <td class="c-footer"></td>
    <td class="c-status"></td>
    <td class="w30"></td>`;
  tr.querySelector('b').textContent = item.name;
  tr.querySelector('small').textContent = shortPath(item.path);
  tr.querySelector('.c-size').textContent = human(item.size);
  rowNodes.set(item.path, tr);
  return tr;
}

function updateRow(tr, item) {
  tr.querySelector('.c-footer').innerHTML = item.footer
    ? `<span class="badge">${FOOTER_LABEL[item.footer] || item.footer}</span>` : '—';

  const cell = tr.querySelector('.c-status');
  const cls = STATUS_CLASS[item.status] || 'wait';
  cell.innerHTML = `<span class="badge ${cls}">${item.status}</span>`;

  const outCell = tr.querySelector('.w30');
  if (item.status === '进行中') {
    const pct = Math.max(item.progress || 0, 2);
    outCell.innerHTML = `<div class="mini"><i style="width:${pct}%"></i></div>
      <span class="miniText">${item.detail || '处理中'} · ${Math.round(item.progress || 0)}%</span>`;
  } else if (item.status === '完成' && item.result) {
    const r = item.result;
    outCell.innerHTML = `<a class="outLink" href="#" data-reveal="${r.mp3}">打开所在位置</a>
      <span class="miniText">${r.codec} ${Math.round(r.src_bitrate / 1000)}k ·
      ${fmtTime(r.duration)} · ${human(r.size)} → MP3</span>`;
  } else if (item.status === '失败') {
    outCell.innerHTML = `<span class="errText">${item.error || '失败'}</span>`;
  } else {
    outCell.textContent = '—';
  }
}

function renderItems(items) {
  const body = $('queueBody');
  const seen = new Set();
  for (const item of items) {
    seen.add(item.path);
    let tr = rowNodes.get(item.path);
    if (!tr) { tr = buildRow(item); body.appendChild(tr); }
    updateRow(tr, item);
  }
  for (const [path, tr] of rowNodes) {
    if (!seen.has(path)) { tr.remove(); rowNodes.delete(path); }
  }
  $('queueEmpty').style.display = items.length ? 'none' : 'block';
  $('queueCount').textContent = items.length ? `${items.length} 个文件` : '';
}

function renderLogs(logs) {
  const box = $('logs');
  if (box.childElementCount !== logs.length) {
    box.innerHTML = '';
    for (const l of logs) {
      const d = document.createElement('div');
      d.className = l.level || 'info';
      d.textContent = `[${l.t}] ${l.text}`;
      box.appendChild(d);
    }
    box.scrollTop = box.scrollHeight;
  }
}

function renderProgress(state) {
  const s = state.stats;
  const donePct = s.total ? (s.done + s.failed) / s.total : 0;
  const cur = state.items.find((i) => i.status === '进行中');
  const frac = cur ? (cur.progress || 0) / 100 : 0;
  const pct = s.total ? (donePct + (cur ? frac / s.total : 0)) * 100 : 0;
  $('progFill').style.width = `${Math.min(pct, 100).toFixed(1)}%`;
  $('progText').textContent = state.running
    ? `${s.done + s.failed}/${s.total} · ${cur ? (cur.detail || '处理中') : '准备中'}`
    : (s.total ? `空闲 · 已完成 ${s.done}${s.failed ? ` · 失败 ${s.failed}` : ''}` : '空闲');
  $('btnStart').disabled = state.running || !s.total;
  $('btnStop').disabled = !state.running;
}

function renderSettings(state) {
  if (document.activeElement !== $('outdir')) $('outdir').value = state.outdir;
  if (document.activeElement !== $('bitrate')) $('bitrate').value = state.bitrate;
  if (document.activeElement !== $('keepOgg')) $('keepOgg').checked = !!state.keep_ogg;
}

async function poll() {
  try {
    const state = await api('/api/state');
    if (state.version !== lastVersion) {
      lastVersion = state.version;
      renderItems(state.items);
      renderLogs(state.logs);
    }
    renderProgress(state);
    renderSettings(state);
  } catch (err) {
    $('progText').textContent = `与服务失联：${err.message}`;
  }
}

async function loadStatus() {
  const { engine, defaults } = await api('/api/status');
  HOME = defaults.home || '';
  const ff = $('pillFfmpeg');
  ff.textContent = engine.ffmpeg ? 'ffmpeg 就绪' : '缺少 ffmpeg';
  ff.className = `pill ${engine.ffmpeg ? 'ok' : 'bad'}`;
  const acc = $('pillAccount');
  acc.textContent = engine.credentials
    ? `已登录 ${engine.account}${engine.login_type === '3' ? '（微信）' : '（QQ）'}`
    : (engine.error || '未检测到登录');
  acc.className = `pill ${engine.credentials ? 'ok' : 'bad'}`;
  acc.title = engine.error || `凭据文件：${engine.cache_dir}`;
}

// ---------------- 拖拽（Chrome/Edge 可拿到真实路径） ----------------
function wireDrop() {
  const zone = $('dropZone');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    stop(e); zone.classList.add('hot');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    stop(e); if (ev === 'drop' || e.target === document.documentElement) zone.classList.remove('hot');
  }));

  document.addEventListener('drop', async (e) => {
    const paths = [];
    const items = e.dataTransfer.items || [];
    for (const it of items) {
      const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry && entry.path) paths.push(entry.path);
      else if (it.getAsFile) {
        const f = it.getAsFile();
        if (f && f.path) paths.push(f.path);
      }
    }
    if (!paths.length) {
      for (const f of e.dataTransfer.files || []) if (f.path) paths.push(f.path);
    }
    if (!paths.length) {
      alert('浏览器没给到文件路径。请改用「选择文件」或「选择文件夹」按钮。');
      return;
    }
    const { added } = await api('/api/add', { paths });
    lastVersion = -1;
    poll();
    if (!added) console.log('没有新增文件');
  });
}

function wire() {
  $('btnPickFiles').onclick = async () => {
    try {
      const { paths } = await api('/api/pick/files', {});
      if (paths.length) await api('/api/add', { paths });
      lastVersion = -1; poll();
    } catch (e) { alert(`选择文件失败：${e.message}`); }
  };

  $('btnPickFolder').onclick = async () => {
    try {
      const r = await api('/api/pick/folder', {});
      lastVersion = -1; poll();
      if (r.folder && !r.files.length) {
        alert(`目录里没有受支持的加密音频：\n${r.folder}`);
      }
    } catch (e) { alert(`选择文件夹失败：${e.message}`); }
  };

  $('btnAddPath').onclick = async () => {
    const raw = prompt('粘贴文件或文件夹的完整路径（多个用换行分隔）');
    if (!raw) return;
    const paths = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    await api('/api/add', { paths });
    lastVersion = -1; poll();
  };

  $('btnPickOut').onclick = async () => {
    try {
      const r = await api('/api/pick/folder', { outdir: true });
      if (r.folder) await api('/api/config', { outdir: r.folder });
      lastVersion = -1; poll();
    } catch (e) { alert(`选择目录失败：${e.message}`); }
  };

  $('btnReveal').onclick = () => api('/api/reveal', { path: $('outdir').value });
  $('btnStart').onclick = async () => {
    const r = await api('/api/start', {});
    if (!r.ok) alert(r.message || '无法开始');
    lastVersion = -1; poll();
  };
  $('btnStop').onclick = () => api('/api/stop', {});
  $('btnClearDone').onclick = async () => { await api('/api/clear', { only_finished: true }); lastVersion = -1; poll(); };
  $('btnClearAll').onclick = async () => {
    if (!confirm('清空整个队列？')) return;
    await api('/api/clear', { only_finished: false }); lastVersion = -1; poll();
  };
  $('btnReloadCred').onclick = async () => {
    await api('/api/credentials/reload', {});
    await loadStatus();
    poll();
  };

  $('outdir').onchange = () => api('/api/config', { outdir: $('outdir').value }).then(() => { lastVersion = -1; poll(); });
  $('bitrate').onchange = () => api('/api/config', { bitrate: $('bitrate').value });
  $('keepOgg').onchange = () => api('/api/config', { keep_ogg: $('keepOgg').checked });

  $('btnLog').onclick = () => $('drawer').classList.toggle('open');
  $('btnCloseLog').onclick = () => $('drawer').classList.remove('open');
  $('btnQuit').onclick = async () => {
    if (!confirm('关闭 QQ 音乐解锁器后台服务？\n（已转换好的文件不受影响）')) return;
    try { await api('/api/quit', {}); } catch (e) { /* 进程已退出 */ }
    document.body.innerHTML = `<main><section class="card" style="margin-top:80px;text-align:center">
      <h2 style="margin-bottom:8px">服务已关闭</h2>
      <p class="muted">可以直接关掉这个标签页；下次双击「QQ音乐解锁器」再次启动。</p></section></main>`;
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-reveal]');
    if (a) {
      e.preventDefault();
      api('/api/reveal', { path: a.dataset.reveal });
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('btnStart').click(); }
  });
}

wireDrop();
wire();
loadStatus().catch(() => {});
poll();
setInterval(poll, POLL_MS);
