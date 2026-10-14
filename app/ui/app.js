'use strict';

const TOKEN = '%%TOKEN%%';
const POLL_MS = 700;
const $ = (id) => document.getElementById(id);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let lastVersion = -1;
let engine = null;
let appVersion = '';
let currentRunning = false;
let helpMode = 'guide';
let settingsWarningShown = false;
let polling = false;
let disconnected = false;
let notifiedRun = false;
let activeModal = null;
let previousFocus = null;
let logSignature = '';
const rowNodes = new Map();
const savingFields = new Set();
let configQueue = Promise.resolve();
let pickerOpen = false;

async function api(path, body) {
  const opt = { headers: { 'X-Token': TOKEN } };
  if (body !== undefined) {
    opt.method = 'POST';
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({ error: '响应解析失败' }));
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || data.message || `HTTP ${res.status}`), data);
  return data;
}

const ACTION_LABELS = { login: '登录帮助', settings: '更改保存位置', dependencies: '修复方法', retry: '重试转换', help: '使用帮助' };

function showError(error, isError = true) {
  const info = typeof error === 'string' ? { message: error } : error;
  const next = info.action === 'retry' && ['picker_failed', 'operation_failed', 'busy', 'invalid_request'].includes(info.code) ? 'help' : info.action;
  const message = info.message || info.error || '操作未完成';
  $('noticeText').textContent = [message, info.hint && info.hint !== message ? info.hint : ''].filter(Boolean).join(' · ');
  $('notice').classList.toggle('isError', isError);
  $('btnNoticeAction').hidden = !ACTION_LABELS[next];
  $('btnNoticeAction').textContent = ACTION_LABELS[next] || '';
  $('btnNoticeAction').dataset.nextAction = next || '';
  $('notice').hidden = false;
}

async function nextAction(kind) {
  if (kind === 'settings') {
    if (activeModal) closeModal();
    $('settingsBody').hidden = false;
    $('btnToggleSettings').textContent = '收起';
    $('btnToggleSettings').setAttribute('aria-expanded', 'true');
    $('settingsCard').scrollIntoView({ block: 'center' });
    $('btnPickOut').focus();
  } else if (kind === 'retry') {
    await configQueue;
    await api('/api/credentials/reload');
    await loadStatus();
    const result = await api('/api/start', {});
    if (!result.ok) showError(result);
    else $('notice').hidden = true;
  } else openHelp(kind === 'login' ? 'account' : kind === 'dependencies' ? 'dependencies' : 'guide');
}

// Keep asynchronous failures visible, including file dialogs and lost connections.
function action(id, fn) {
  $(id).onclick = async () => {
    const button = $(id);
    button.disabled = true;
    try { await fn(); } catch (e) { showError(e); }
    finally { button.disabled = false; await poll(); }
  };
}

function human(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0, value = bytes;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(value < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}

function fmtTime(seconds) {
  if (!seconds) return '—';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const STATUS_CLASS = { '等待': 'wait', '进行中': 'run', '完成': 'ok', '失败': 'err' };

function buildRow(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td class="fname"><b></b></td><td class="c-size"></td><td class="c-status"></td><td class="w30"></td>';
  tr.querySelector('b').textContent = item.name;
  tr.querySelector('b').title = item.path;
  tr.querySelector('.c-size').textContent = human(item.size);
  rowNodes.set(item.path, tr);
  return tr;
}

function updateRow(tr, item) {
  const cls = STATUS_CLASS[item.status] || 'wait';
  tr.querySelector('.c-status').innerHTML = `<span class="badge ${cls}">${escapeHTML(item.status)}</span>`;
  const out = tr.querySelector('.w30');
  if (item.status === '进行中') {
    const pct = Math.min(100, Math.max(0, Number(item.progress) || 0));
    out.innerHTML = `<div class="mini"><i style="width:${pct}%"></i></div><span class="miniText">${escapeHTML(item.detail || '处理中')} · ${Math.round(pct)}%</span>`;
  } else if (item.status === '完成' && item.result) {
    const r = item.result;
    out.innerHTML = `<a class="outLink" href="#">打开文件</a><span class="miniText">${fmtTime(r.duration)} · ${human(r.size)}</span>`;
    out.querySelector('a').dataset.revealFile = r.mp3;
  } else if (item.status === '失败') {
    out.innerHTML = `<span class="errText">${escapeHTML(item.error || '转换失败')}</span>`;
    if (item.hint) { const hint = document.createElement('span'); hint.className = 'miniText'; hint.textContent = item.hint; out.appendChild(hint); }
    if (ACTION_LABELS[item.action]) {
      const button = document.createElement('button'); button.className = 'ghost small rowAction';
      button.textContent = ACTION_LABELS[item.action]; button.dataset.nextAction = item.action; out.appendChild(button);
    }
  } else { out.textContent = '—'; }
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
  $('queueCard').hidden = !items.length;
  document.body.classList.toggle('hasItems', items.length > 0);
  $('dropTitle').textContent = items.length ? '继续添加音频' : '拖入音频，开始转换';
  $('queueCount').textContent = items.length ? `${items.length}` : '';
}

function renderLogs(logs) {
  const signature = JSON.stringify(logs);
  if (signature === logSignature) return;
  logSignature = signature;
  const box = $('logs');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  box.replaceChildren();
  for (const log of logs) {
    const line = document.createElement('div');
    line.className = log.level || 'info';
    line.textContent = `[${log.t}] ${log.text}`;
    box.appendChild(line);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderProgress(state) {
  currentRunning = state.running;
  const s = state.stats;
  const current = state.items.find((item) => item.status === '进行中');
  const pct = s.total ? Math.min(100, (s.done + s.failed + (current ? (current.progress || 0) / 100 : 0)) / s.total * 100) : 0;
  $('progFill').style.width = `${pct.toFixed(1)}%`;
  $('progress').setAttribute('aria-valuenow', Math.round(pct));
  if (state.running) $('progText').textContent = `转换中 ${s.done + s.failed + (current ? 1 : 0)} / ${s.total}`;
  else if (s.pending) $('progText').textContent = `待转换 ${s.pending} / ${s.total}`;
  else if (s.total) $('progText').textContent = `完成 ${s.done}${s.failed ? ` · 失败 ${s.failed}` : ''}`;
  else $('progText').textContent = '等待文件';
  $('btnStart').textContent = s.failed && !s.pending ? '重试失败项' : '开始转换';
  $('btnStart').disabled = state.running || !(s.pending || s.failed);
  $('btnStart').hidden = state.running;
  $('btnStop').hidden = !state.running;
  $('btnStop').textContent = state.stopping ? '停止中' : '停止';
  $('btnStop').title = state.stopping ? '当前文件完成后停止' : '';
  $('btnStop').disabled = !state.running || state.stopping;
  $('btnClearAll').disabled = state.running;
  $('btnClearDone').disabled = state.running || !s.done;
}

function renderSettings(state) {
  if (state.settings_warning && !settingsWarningShown) {
    settingsWarningShown = true;
    showError({ message: state.settings_warning, action: 'settings' }, false);
  }
  for (const id of ['outdir', 'bitrate', 'keepOgg', 'btnPickOut']) $(id).disabled = state.running;
  for (const [id, key] of [['outdir', 'outdir'], ['bitrate', 'bitrate'], ['keepOgg', 'keep_ogg']]) {
    const field = $(id);
    if (document.activeElement === field || savingFields.has(id)) continue;
    if (id === 'keepOgg') field.checked = !!state[key];
    else field.value = state[key];
  }
  $('btnOpenOut').title = state.outdir;
}

function renderResult(state) {
  const s = state.stats;
  const bar = $('resultBar');
  if (!s.total || (!s.done && !s.failed) || state.running || s.pending) {
    bar.hidden = true;
    notifiedRun = false;
    return;
  }
  bar.hidden = false;
  bar.classList.toggle('hasError', s.failed > 0);
  $('resultTitle').textContent = `完成 ${s.done}${s.failed ? ` · 失败 ${s.failed}` : ''}`;
  const first = state.items.find((item) => item.status === '失败');
  const completed = state.items.filter((item) => item.status === '完成' && item.result?.mp3);
  const dirs = new Set(completed.map((item) => item.result.mp3.replace(/[\\/][^\\/]*$/, '')));
  $('resultSub').textContent = s.done ? (dirs.size === 1 ? [...dirs][0] : '多个输出目录') : (first?.error || '查看日志');
  $('btnOpenOut').dataset.path = completed[0]?.result.mp3 || state.outdir;
  $('btnOpenOut').hidden = !s.done;
  if (!notifiedRun) {
    notifiedRun = true;
    if (!s.failed && window.Notification && Notification.permission === 'granted') {
      try { new Notification('QQ 音乐解锁器', { body: `已完成 ${s.done} 个文件` }); } catch (_) { /* Optional notification. */ }
    }
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const state = await api('/api/state');
    if (state.version !== lastVersion) {
      lastVersion = state.version;
      renderItems(state.items);
      renderLogs(state.logs);
    }
    renderProgress(state);
    renderSettings(state);
    renderResult(state);
    if (disconnected) { disconnected = false; loadStatus().catch(() => {}); }
  } catch (_) {
    disconnected = true;
    $('progText').textContent = '连接已断开 · 正在重连';
    $('btnStart').disabled = true;
    $('btnStop').disabled = true;
  } finally { polling = false; }
}

async function loadStatus() {
  const data = await api('/api/status');
  engine = data.engine;
  appVersion = data.version || appVersion;
  $('appVersion').textContent = appVersion ? `版本 ${appVersion}` : '';
  const ready = engine.ffmpeg && engine.ffprobe;
  $('pillFfmpeg').textContent = ready ? '转换就绪' : `缺少 ${engine.ffmpeg ? 'ffprobe' : 'ffmpeg'}`;
  $('pillFfmpeg').className = `pill ${ready ? 'ok' : 'bad'}`;
  $('pillAccount').textContent = engine.credentials ? '已读取登录' : '需要登录';
  $('pillAccount').className = `pill link ${engine.credentials ? 'ok' : 'bad'}`;
  $('pillAccount').title = '查看账号状态';
  if (!ready) showError({ message: '转换组件缺失', hint: '请重新下载应用并完整解压。', action: 'dependencies' });
}

function openModal(id, focusId) {
  if (activeModal) closeModal();
  previousFocus = document.activeElement;
  activeModal = $(id);
  activeModal.hidden = false;
  document.body.classList.add('hasModal');
  for (const node of document.querySelectorAll('body > header, body > main, body > footer')) node.inert = true;
  (focusId ? $(focusId) : activeModal.querySelector('button, [tabindex]')).focus();
}

function closeModal() {
  if (!activeModal) return;
  activeModal.hidden = true;
  activeModal = null;
  document.body.classList.remove('hasModal');
  for (const node of document.querySelectorAll('body > header, body > main, body > footer')) node.inert = false;
  previousFocus?.focus();
}

function openHelp(mode = 'guide') {
  helpMode = mode;
  const e = engine || {};
  const help = e.help || {};
  $('helpTitle').textContent = mode === 'account' ? '登录 QQ 音乐' : mode === 'dependencies' ? '修复转换组件' : '从哪里开始';
  const rows = [];
  if (mode === 'dependencies') rows.push('<p>重新下载适合当前系统的应用，完整解压后再打开。请勿单独移动程序内部文件。</p><p class="muted">正式下载包自带转换组件，无需安装 Python 或 FFmpeg。</p>');
  else if (mode === 'guide') rows.push('<ol class="quickSteps"><li><strong>在 QQ 音乐中下载歌曲</strong><span>先登录桌面客户端，下载需要转换的歌曲。</span></li><li><strong>找到本地文件，拖入此窗口</strong><span>在 QQ 音乐的「本地与下载」或下载列表中，右键歌曲查找「打开文件所在目录」；也可在客户端设置中查看下载目录。</span></li><li><strong>转换完成，打开结果</strong><span>文件会自动开始转换，MP3 保存在主界面的「保存到」目录。原文件不变，同名结果自动编号。</span></li></ol><p class="muted">支持 MGG / MFLAC / QMC 系列文件；歌曲链接、MP3 和 AAC 无需在这里转换。</p>');
  rows.push(`<p class="accountState">${e.credentials ? '✓ 已读取 QQ 音乐登录状态' : '需要登录 QQ 音乐客户端，再点「重新检测」。'}</p>`);
  if (mode === 'account') rows.push('<p class="muted">部分文件自带密钥，可直接尝试转换；其他文件需要可用的客户端登录状态和歌曲权限。</p>');
  if (!e.credentials && e.credential_error) rows.push(`<p class="errText">${escapeHTML(e.credential_error.error || e.credential_error.message || e.credential_error)}</p>`);
  if (help.checks?.length || help.steps?.length) {
    rows.push('<details><summary>排查详情</summary>');
    if (help.checks?.length) {
      rows.push('<ul class="checks">');
      for (const check of help.checks) rows.push(`<li>${check.ok ? '✓' : '✗'} ${escapeHTML(check.name)}<span class="mono muted">${escapeHTML(check.path || (check.paths || []).join('、'))}</span></li>`);
      rows.push('</ul>');
    }
    if (!e.credentials && help.steps?.length) rows.push(`<ol class="steps">${help.steps.map((step) => `<li>${escapeHTML(step)}</li>`).join('')}</ol>`);
    rows.push('</details>');
  }
  $('helpBody').innerHTML = rows.join('');
  $('btnHelpCopy').textContent = '复制排查信息';
  openModal('helpModal');
}

function addMessage(result) {
  const reasons = {
    duplicate: '这些文件已在队列中，无需重复添加。',
    missing: '文件不存在，请检查路径或重新选择文件。',
    unreadable: '无法读取文件，请检查访问权限。',
    unsupported: '请选择 MGG / MFLAC / QMC 文件。MP3、歌曲链接等不在支持范围内。',
    empty_folder: '文件夹中没有 MGG / MFLAC / QMC 文件，请检查 QQ 音乐的下载目录。',
    no_selection: '请选择歌曲文件或文件夹。',
    cancelled: '',
  };
  return reasons[result.reason] ?? result.message ?? result.reason ?? '没有可添加的歌曲文件。';
}

function handleAddResponse(result) {
  if (result.error) showError(result);
  else if (result.start_error) showError(result.start_error);
  else if (!result.added && result.reason !== 'cancelled') showError(addMessage(result), false);
  else if (result.skipped) {
    const details = [['duplicate', '已在队列'], ['unsupported', '格式不支持'], ['missing', '不存在'], ['unreadable', '无法读取']]
      .filter(([key]) => result[key]).map(([key, label]) => `${label} ${result[key]}`).join('，');
    showError(`已添加 ${result.added} 个文件 · ${details || `跳过 ${result.skipped} 个文件`}`, false);
  }
  else $('notice').hidden = true;
  lastVersion = -1;
  poll();
  return result;
}
window.handleNativeAddResult = handleAddResponse;

async function addPaths(paths) {
  if (pickerOpen) throw new Error('请先完成文件夹选择，再添加歌曲。');
  await configQueue;
  const result = handleAddResponse(await api('/api/open', { paths, auto_start: true }));
  await poll();
  return result;
}

function wireDrop() {
  const zone = $('dropZone');
  ['dragenter', 'dragover'].forEach((event) => document.addEventListener(event, (e) => { e.preventDefault(); zone.classList.add('hot'); }));
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) zone.classList.remove('hot'); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('hot');
    // pywebview's native DOM handler supplies full paths. Do not process twice.
    if (window.pywebview || window.__nativeDropReady) return;
    const paths = Array.from(e.dataTransfer?.files || []).map((file) => file.pywebviewFullPath || file.path).filter(Boolean);
    if (!paths.length) { showError('无法读取拖入路径，请选择文件或输入路径。'); return; }
    try { await addPaths(paths); } catch (error) { showError(error); }
  });
}

async function saveSetting(id, key, value) {
  savingFields.add(id);
  $('settingsSaved').textContent = '保存中';
  const operation = configQueue.catch(() => {}).then(() => api('/api/config', { [key]: value }));
  configQueue = operation;
  try { await operation; $('settingsSaved').textContent = '已保存'; }
  catch (e) { $('settingsSaved').textContent = '未保存'; showError(e); }
  finally {
    if (configQueue === operation) configQueue = Promise.resolve();
    savingFields.delete(id); lastVersion = -1; await poll();
  }
}

function wire() {
  action('btnPickFiles', async () => {
    const { paths } = await api('/api/pick/files', {});
    if (paths?.length) await addPaths(paths);
  });
  action('btnPickFolder', async () => {
    await configQueue;
    const result = await api('/api/pick/folder', {});
    if (result.folder) handleAddResponse(result);
    lastVersion = -1;
  });
  $('btnAddPath').onclick = () => { $('pathError').hidden = true; openModal('pathModal', 'paths'); };
  $('pathForm').onsubmit = async (event) => {
    event.preventDefault();
    const paths = $('paths').value.split('\n').map((path) => path.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
    if (!paths.length) return;
    const button = event.submitter || $('pathForm').querySelector('[type=submit]');
    button.disabled = true;
    try {
      const result = await addPaths(paths);
      if (result.added) { closeModal(); $('paths').value = ''; }
      else { $('pathError').textContent = addMessage(result); $('pathError').hidden = false; }
    } catch (e) { $('pathError').textContent = e.message; $('pathError').hidden = false; }
    finally { button.disabled = false; }
  };
  action('btnPickOut', async () => {
    await configQueue;
    pickerOpen = true;
    try {
      const result = await api('/api/pick/folder', { outdir: true });
      if (result.folder) $('settingsSaved').textContent = '已保存';
    } finally { pickerOpen = false; lastVersion = -1; }
  });
  action('btnReveal', () => api('/api/reveal', { path: $('outdir').value }));
  action('btnOpenOut', () => api('/api/reveal', { path: $('btnOpenOut').dataset.path }));
  $('btnResultMore').onclick = $('btnLog').onclick = () => openModal('logModal');
  action('btnStart', async () => {
    if (pickerOpen) throw new Error('请先完成文件夹选择，再开始转换。');
    await configQueue;
    const result = await api('/api/start', {}); if (!result.ok) showError(result); else $('notice').hidden = true; lastVersion = -1;
  });
  action('btnStop', () => api('/api/stop', {}));
  action('btnClearDone', async () => { await api('/api/clear', { only_finished: true }); lastVersion = -1; });
  action('btnClearAll', async () => { await api('/api/clear', { only_finished: false }); lastVersion = -1; });
  const reload = async () => { await api('/api/credentials/reload'); await loadStatus(); if (activeModal?.id === 'helpModal') openHelp(helpMode); };
  action('btnReloadCred', reload);
  action('btnHelpRetry', reload);
  action('btnOpenQQMusic', async () => {
    try { await api('/api/qqmusic/open', {}); }
    catch (e) { closeModal(); throw e; }
  });
  action('btnHelpCopy', async () => {
    // Diagnostics contain status only, never cookies, tokens or account identifiers.
    const info = { version: appVersion, platform: engine?.platform, ffmpeg: engine?.ffmpeg, ffprobe: engine?.ffprobe,
      credentials: !!engine?.credentials, dependency_error: engine?.dependency_error, credential_error: engine?.credential_error };
    try { await navigator.clipboard.writeText(JSON.stringify(info, null, 2)); $('btnHelpCopy').textContent = '已复制'; }
    catch (_) { closeModal(); showError('复制失败，请在日志中查看错误信息。'); }
  });
  $('bitrate').onchange = () => saveSetting('bitrate', 'bitrate', $('bitrate').value);
  $('keepOgg').onchange = () => saveSetting('keepOgg', 'keep_ogg', $('keepOgg').checked);
  $('btnToggleSettings').onclick = () => {
    const hidden = !$('settingsBody').hidden;
    $('settingsBody').hidden = hidden;
    $('btnToggleSettings').textContent = hidden ? '展开' : '收起';
    $('btnToggleSettings').setAttribute('aria-expanded', String(!hidden));
  };
  for (const id of ['btnCloseLog', 'btnCloseHelp', 'btnClosePath']) $(id).onclick = closeModal;
  for (const modal of document.querySelectorAll('.modal')) modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  $('pillAccount').onclick = () => openHelp('account');
  $('btnHelp').onclick = $('btnFindMusic').onclick = () => openHelp('guide');
  $('btnDismissNotice').onclick = () => { $('notice').hidden = true; };
  $('btnQuit').onclick = async () => {
    if (currentRunning && !confirm('正在转换，退出会中断当前文件。确定退出？')) return;
    try { await api('/api/quit', {}); }
    catch (e) { showError(e); return; }
    clearInterval(pollTimer);
    document.body.innerHTML = '<main><section class="drop"><div class="dropInner"><h2>已退出</h2></div></section></main>';
  };
  document.addEventListener('click', async (event) => {
    const next = event.target.closest('[data-next-action]');
    if (next?.dataset.nextAction) {
      next.disabled = true;
      try { await nextAction(next.dataset.nextAction); } catch (e) { showError(e); }
      finally { next.disabled = false; await poll(); }
      return;
    }
    const link = event.target.closest('[data-reveal-file]');
    if (!link) return;
    event.preventDefault();
    try { await api('/api/reveal', { path: link.dataset.revealFile }); } catch (e) { showError(e); }
  });
  document.addEventListener('keydown', (event) => {
    if (activeModal) {
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
      if (event.key === 'Tab') {
        const nodes = [...activeModal.querySelectorAll('button:not(:disabled), input, textarea, select, a[href], summary, [tabindex="0"]')].filter((node) => node.getClientRects().length);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('btnStart').click(); }
  });
}

wireDrop();
wire();
loadStatus().catch(() => { $('pillFfmpeg').textContent = '检测失败'; $('pillAccount').textContent = '账号未知'; });
poll();
const pollTimer = setInterval(poll, POLL_MS);
