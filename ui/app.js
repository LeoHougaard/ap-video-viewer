const $ = (id) => document.getElementById(id);
const video = $('video');
const apHost = $('ap-player-host');
let clips = [];
let source = 'files';
let selected = -1;
let apPlayer = null;
let saveTimer;
let exportTimer;
const durations = new Map();

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function message(id, text, error = false) {
  const element = $(id);
  element.textContent = text;
  element.classList.toggle('error', error);
}

function timeLabel(value) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function currentClip() { return clips[selected]; }
function currentTime() { return apPlayer ? Number(apPlayer.currentTime || 0) : video.currentTime; }
function seek(time) { if (apPlayer) apPlayer.currentTime = time; else video.currentTime = time; }

function render() {
  $('clip-count').textContent = clips.length;
  $('previous').disabled = selected <= 0;
  $('next').disabled = selected < 0 || selected >= clips.length - 1;
  $('trim').disabled = selected < 0;
  $('set-playhead').disabled = selected < 0;
  $('export').hidden = source === 'ap';
  $('export').disabled = !clips.length;
  const list = $('playlist');
  list.replaceChildren();
  if (!clips.length) {
    const empty = document.createElement('div');
    empty.className = 'playlist-empty';
    empty.textContent = 'No videos in the queue.';
    list.append(empty);
  }
  clips.forEach((clip, index) => {
    const row = document.createElement('div');
    row.className = `clip${index === selected ? ' active' : ''}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Play ${clip.name}`);
    const number = document.createElement('span');
    number.className = 'clip-num';
    number.textContent = String(index + 1).padStart(2, '0');
    const body = document.createElement('span');
    body.className = 'clip-body';
    const name = document.createElement('span');
    name.className = 'clip-name';
    name.textContent = clip.name;
    name.title = clip.path;
    const meta = document.createElement('span');
    meta.className = 'clip-meta';
    const duration = durations.get(clip.id);
    meta.textContent = `${duration ? timeLabel(duration - clip.trim) : ''}${clip.trim ? `${duration ? ' · ' : ''}skip ${timeLabel(clip.trim)}` : ''}${!clip.browserPlayable ? ' · browser support varies' : ''}`;
    body.append(name, meta);
    const actions = document.createElement('span');
    actions.className = 'clip-actions';
    for (const [direction, symbol] of [[-1, '▲'], [1, '▼']]) {
      const button = document.createElement('button');
      button.textContent = symbol;
      button.title = direction < 0 ? 'Move up' : 'Move down';
      button.disabled = index + direction < 0 || index + direction >= clips.length;
      button.addEventListener('click', (event) => { event.stopPropagation(); move(index, direction); });
      actions.append(button);
    }
    row.append(number, body, actions);
    row.addEventListener('click', () => playClip(index, true));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') playClip(index, true); });
    list.append(row);
  });
}

function playClip(index, autoplay = false) {
  if (index < 0 || index >= clips.length) return;
  selected = index;
  const clip = currentClip();
  $('empty-state').hidden = true;
  $('current-title').textContent = clip.name;
  $('trim').value = clip.trim;
  message('trim-feedback', '');
  if (clip.source === 'ap') {
    video.pause();
    video.hidden = true;
    apHost.hidden = false;
    apHost.replaceChildren();
    const player = document.createElement('wistia-player');
    player.setAttribute('media-id', clip.id);
    player.setAttribute('resumable', 'false');
    apPlayer = player;
    if (!document.querySelector(`script[data-media-id="${clip.id}"]`)) {
      const script = document.createElement('script');
      script.src = `https://fast.wistia.com/embed/${clip.id}.js`;
      script.type = 'module';
      script.async = true;
      script.dataset.mediaId = clip.id;
      document.head.append(script);
    }
    player.addEventListener('api-ready', () => {
      if (player !== apPlayer) return;
      durations.set(clip.id, player.duration);
      player.currentTime = Math.min(clip.trim, Math.max(0, player.duration - 0.1));
      player.playbackRate = Number($('speed').value);
      render();
      if (autoplay) Promise.resolve(player.play()).catch(() => message('trim-feedback', 'Press play to continue.', true));
    }, { once: true });
    player.addEventListener('ended', () => {
      if (player === apPlayer && selected < clips.length - 1) playClip(selected + 1, true);
    });
    player.addEventListener('time-update', () => {
      if (player === apPlayer && player.currentTime < clip.trim - 0.05) player.currentTime = clip.trim;
    });
    apHost.append(player);
  } else {
    apHost.replaceChildren();
    apHost.hidden = true;
    apPlayer = null;
    video.hidden = false;
    video.src = clip.url;
    video.load();
    video.onloadedmetadata = () => {
      if (currentClip() !== clip) return;
      durations.set(clip.id, video.duration);
      video.currentTime = Math.min(clip.trim, Math.max(0, video.duration - 0.1));
      video.playbackRate = Number($('speed').value);
      render();
      if (autoplay) video.play().catch(() => message('trim-feedback', 'Press play to continue.', true));
    };
  }
  render();
}

function move(index, direction) {
  const next = index + direction;
  [clips[index], clips[next]] = [clips[next], clips[index]];
  if (selected === index) selected = next;
  else if (selected === next) selected = index;
  render();
  queueSave();
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 200);
}

async function saveProject() {
  try {
    await api('/api/project', { method: 'POST', body: JSON.stringify({ items: clips.map(({ id, trim }) => ({ id, trim })) }) });
    message('trim-feedback', 'Saved');
    return true;
  } catch (error) {
    message('trim-feedback', error.message, true);
    return false;
  }
}

async function refresh(preserve = true) {
  try {
    const id = preserve ? currentClip()?.id : null;
    const data = await api('/api/project');
    clips = data.clips;
    source = data.source;
    $('course-name').textContent = source === 'ap' ? `${data.courseName} · Unit ${clips[0]?.unit || ''}` : '';
    $('folder').value = data.folder;
    selected = clips.findIndex((clip) => clip.id === id);
    if (selected < 0 && clips.length) playClip(0);
    else if (!clips.length) {
      apHost.replaceChildren();
      apHost.hidden = true;
      apPlayer = null;
      video.hidden = false;
      video.removeAttribute('src');
      video.load();
      $('empty-state').hidden = false;
      $('current-title').textContent = 'No video selected';
    }
    render();
    showExport(data.export);
  } catch (error) { message('folder-feedback', error.message, true); }
}

async function loadFolder() {
  try {
    await api('/api/folder', { method: 'POST', body: JSON.stringify({ folder: $('folder').value }) });
    durations.clear();
    selected = -1;
    await refresh(false);
    message('folder-feedback', `${clips.length} videos loaded.`);
  } catch (error) { message('folder-feedback', error.message, true); }
}

async function chooseFolder() {
  try {
    const result = await api('/api/choose-folder', { method: 'POST', body: '{}' });
    if (result.folder) { $('folder').value = result.folder; await loadFolder(); }
  } catch (error) { message('folder-feedback', error.message, true); }
}

function showExport(status) {
  if (source === 'ap') { message('export-status', ''); return; }
  if (status.state === 'running') message('export-status', 'Exporting…');
  else if (status.state === 'done') message('export-status', `Saved: ${status.file}`);
  else if (status.state === 'error') message('export-status', status.message, true);
  else message('export-status', '');
  $('export').disabled = !clips.length || status.state === 'running';
  if (status.state === 'running' && !exportTimer) {
    exportTimer = setInterval(async () => {
      try {
        const result = await api('/api/export');
        if (result.state !== 'running') { clearInterval(exportTimer); exportTimer = null; }
        showExport(result);
      } catch (error) { message('export-status', error.message, true); }
    }, 1200);
  }
}

function collectAPUnit(base) {
  try {
    if (location.hostname !== 'apclassroom.collegeboard.org') throw new Error('Open AP Classroom first.');
    const button = document.querySelector('button[data-index]');
    if (!button) throw new Error('Open a video in the unit first.');
    let fiber = button[Object.keys(button).find((key) => key.startsWith('__reactFiber$'))];
    while (fiber && !Array.isArray(fiber.memoizedProps?.allAvailableVideoResources)) fiber = fiber.return;
    const resources = fiber?.memoizedProps?.allAvailableVideoResources;
    if (!resources?.length) throw new Error('Could not read this course video list.');
    const courseId = location.pathname.split('/')[1];
    const unit = new URL(location.href).searchParams.get('unit');
    if (!unit) throw new Error('Open the unit you want to import.');
    const clips = resources.filter((item) => String(item.unitId) === unit && item.url && item.displayName)
      .map((item) => ({ id: item.url, name: item.displayName, unit: item.unitId }));
    if (!clips.length) throw new Error('No videos found in this unit.');
    const courseName = document.title.split(/ Unit \d+/)[0] || 'AP Classroom';
    const destination = base + '/#ap-import=' + encodeURIComponent(JSON.stringify({ courseId, courseName, clips }));
    if (!window.open(destination, '_blank')) location.assign(destination);
  } catch (error) { alert(`AP video viewer: ${error.message}`); }
}

async function importFromHash() {
  if (!location.hash.startsWith('#ap-import=')) return refresh(false);
  try {
    const payload = JSON.parse(decodeURIComponent(location.hash.slice('#ap-import='.length)));
    const result = await api('/api/ap-import', { method: 'POST', body: JSON.stringify(payload) });
    history.replaceState(null, '', '/');
    durations.clear();
    await refresh(false);
    message('ap-feedback', `Imported ${result.count} videos.`);
  } catch (error) { message('ap-feedback', error.message, true); }
}

$('import-unit').href = `javascript:(${collectAPUnit.toString()})(${JSON.stringify(location.origin)})`;
$('import-unit').addEventListener('click', (event) => {
  event.preventDefault();
  message('ap-feedback', 'Save this link as a bookmark. Then click the bookmark while the AP video is open.');
});
$('copy-import').addEventListener('click', async () => {
  const bookmarkUrl = $('import-unit').href;
  const field = document.createElement('textarea');
  field.value = bookmarkUrl;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* Try the Clipboard API. */ }
  field.remove();
  if (!copied && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(bookmarkUrl);
      copied = true;
    } catch { /* Show the drag option below. */ }
  }
  if (!copied) return message('ap-feedback', 'Copy failed. Drag the link to your bookmarks toolbar instead.', true);
  message('ap-feedback', 'Copied. Create a bookmark and paste this as its URL. Click it on the AP Classroom video page.');
});
$('browse').addEventListener('click', chooseFolder);
$('use-folder').addEventListener('click', loadFolder);
$('refresh').addEventListener('click', () => refresh());
$('previous').addEventListener('click', () => playClip(selected - 1, true));
$('next').addEventListener('click', () => playClip(selected + 1, true));
$('trim').addEventListener('change', () => {
  const value = Number($('trim').value);
  const duration = durations.get(currentClip()?.id);
  if (!Number.isFinite(value) || value < 0 || value >= 86400 || duration && value >= duration) {
    message('trim-feedback', 'Enter a start time before the clip ends.', true);
    $('trim').value = currentClip()?.trim || 0;
    return;
  }
  currentClip().trim = Math.round(value * 10) / 10;
  if (currentTime() < value) seek(value);
  render();
  queueSave();
});
$('set-playhead').addEventListener('click', () => {
  $('trim').value = Math.floor(currentTime() * 10) / 10;
  $('trim').dispatchEvent(new Event('change'));
});
$('speed').addEventListener('change', () => {
  const speed = Number($('speed').value);
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 16) {
    $('speed').value = apPlayer?.playbackRate || video.playbackRate || 1;
    return;
  }
  video.playbackRate = speed;
  if (apPlayer) apPlayer.playbackRate = speed;
  localStorage.setItem('ap-viewer-speed', String(speed));
});
$('export').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  if (!await saveProject()) return;
  try { showExport(await api('/api/export', { method: 'POST', body: '{}' })); }
  catch (error) { showExport({ state: 'error', message: error.message }); }
});
video.addEventListener('ended', () => { if (selected < clips.length - 1) playClip(selected + 1, true); });
video.addEventListener('seeking', () => { if (currentClip() && video.currentTime < currentClip().trim - 0.05) video.currentTime = currentClip().trim; });
video.addEventListener('error', () => { if (currentClip()) message('trim-feedback', 'This file may not play in the browser. Try MP4 or WebM.', true); });
document.addEventListener('keydown', (event) => {
  if (['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName) || !currentClip()) return;
  if (event.code === 'Space') { event.preventDefault(); apPlayer ? (apPlayer.state === 'playing' ? apPlayer.pause() : apPlayer.play()) : (video.paused ? video.play() : video.pause()); }
  if (event.code === 'ArrowLeft') { event.preventDefault(); seek(Math.max(currentClip().trim, currentTime() - 5)); }
  if (event.code === 'ArrowRight') { event.preventDefault(); seek(Math.min(durations.get(currentClip().id) || Infinity, currentTime() + 5)); }
});

const savedSpeed = Number(localStorage.getItem('ap-viewer-speed'));
if (savedSpeed >= 0.1 && savedSpeed <= 16) $('speed').value = savedSpeed;
$('speed').dispatchEvent(new Event('change'));
importFromHash();
