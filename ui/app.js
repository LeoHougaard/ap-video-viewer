const $ = (id) => document.getElementById(id);
const video = $('video');
const apHost = $('ap-player-host');
let clips = [], libraries = [], libraryId = '', source = 'files', selected = -1;
let apPlayer = null, ready = false, loading = false, finished = false, muted = true;
// Storage can be unavailable in private browsing. Playback should still work.
function stored(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
let speed = Number(stored('ap-viewer-speed')) || 1.5;
if (speed < 0.25 || speed > 16) speed = 1.5;
let saveTimer, loadTimer, exportTimer, saveChain = Promise.resolve(true), dirty = false;
let revision = 0, switching = false, generation = 0;
let apEvents;
let seekTarget = null;
const durations = new Map();

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function message(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', error);
}
function timeLabel(value, precise = false) {
  const n = Math.round(Math.max(0, value || 0) * 10) / 10;
  const whole = Math.floor(n);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}${precise && n % 1 ? '.' + Math.round(n % 1 * 10) : ''}`;
}
function parseTime(text) {
  if (!/^\d+(?:\.\d{1,3})?$|^\d+:\d{1,2}(?:\.\d{1,3})?$/.test(text.trim())) return NaN;
  const parts = text.trim().split(':').map(Number);
  if (parts.length === 2 && parts[1] >= 60) return NaN;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
}
function currentClip() { return clips[selected]; }
function player() { return apPlayer || video; }
function currentTime() { return seekTarget ?? Number(player().currentTime || 0); }
function isPlaying() { return ready && (apPlayer ? apPlayer.state === 'playing' : !video.paused); }
function endTime() { return Math.min(currentClip()?.end ?? Infinity, durations.get(currentClip()?.id) || Infinity); }
function seek(time) {
  if (!ready) return;
  seekTarget = Math.max(currentClip().trim, Math.min(time, endTime()));
  player().currentTime = seekTarget;
  settleSeek();
}
function settleSeek() {
  if (seekTarget !== null && Math.abs(Number(player().currentTime || 0) - seekTarget) < 0.1) seekTarget = null;
}
function checkpoint() {
  if (!ready || !currentClip()) return;
  store(`ap-viewer-place:${libraryId}`, { id: currentClip().id, time: currentTime() });
}
function pause() { if (typeof player().pause === 'function') player().pause(); }

function renderLibrary() {
  const active = libraries.find((entry) => entry.id === libraryId);
  const courses = [...new Map(libraries.filter((entry) => entry.source === 'ap' || entry.id === libraryId || entry.count).map((entry) => [entry.courseId, entry])).values()];
  $('course').replaceChildren(...courses.map((entry) => new Option(entry.courseName, entry.courseId)));
  $('course').value = active?.courseId || 'files';
  const units = libraries.filter((entry) => entry.courseId === active?.courseId).sort((a, b) => Number(a.unit) - Number(b.unit));
  $('unit').replaceChildren(...units.map((entry) => new Option(entry.source === 'ap' ? `Unit ${entry.unit}` : 'All videos', entry.id)));
  $('unit').value = libraryId;
  $('course').disabled = switching || loading || !courses.length;
  $('unit').disabled = switching || loading || !units.length;
}
function renderQueue() {
  $('clip-count').textContent = clips.length;
  $('playlist').replaceChildren();
  if (!clips.length) {
    const empty = document.createElement('p');
    empty.className = 'playlist-empty'; empty.textContent = 'Add a course to choose its videos.';
    $('playlist').append(empty);
  }
  clips.forEach((clip, index) => {
    const row = document.createElement('div'); row.className = `clip${index === selected ? ' active' : ''}`;
    const button = document.createElement('button'); button.className = 'clip-play';
    button.setAttribute('aria-label', `Play ${clip.name}`);
    button.disabled = loading;
    if (index === selected) button.setAttribute('aria-current', 'true');
    const number = document.createElement('span'); number.className = 'clip-num'; number.textContent = String(index + 1).padStart(2, '0');
    const body = document.createElement('span'); body.className = 'clip-body';
    const name = document.createElement('span'); name.className = 'clip-name'; name.textContent = clip.name;
    const meta = document.createElement('span'); meta.className = 'clip-meta';
    const end = clip.end ?? durations.get(clip.id);
    meta.textContent = `${timeLabel(clip.trim)} to ${end ? timeLabel(end) : 'end'}${!clip.browserPlayable ? ' · browser support varies' : ''}`;
    body.append(name, meta); button.append(number, body);
    button.addEventListener('click', () => playClip(index, true));
    const actions = document.createElement('span'); actions.className = 'clip-actions';
    for (const [direction, symbol] of [[-1, '▲'], [1, '▼']]) {
      const move = document.createElement('button'); move.textContent = symbol;
      move.setAttribute('aria-label', `Move ${clip.name} ${direction < 0 ? 'up' : 'down'}`);
      move.disabled = index + direction < 0 || index + direction >= clips.length;
      move.addEventListener('click', () => {
        const active = currentClip();
        [clips[index], clips[index + direction]] = [clips[index + direction], clips[index]];
        selected = clips.indexOf(active); renderQueue(); renderControls(); queueSave();
      });
      actions.append(move);
    }
    row.append(button, actions); $('playlist').append(row);
  });
}
function renderControls() {
  const clip = currentClip();
  $('previous').disabled = loading || selected <= 0;
  $('next').disabled = loading || selected < 0 || selected === clips.length - 1;
  for (const id of ['play', 'seek', 'trim', 'end', 'start-range', 'end-range', 'set-start', 'set-end', 'reset']) $(id).disabled = !ready;
  $('play').textContent = !clip ? 'Play' : !ready ? 'Loading' : isPlaying() ? 'Pause' : finished ? 'Replay' : 'Play';
  $('export').hidden = source === 'ap';
  if (!clip) return;
  const duration = durations.get(clip.id) || 1;
  $('trim').value = timeLabel(clip.trim, true);
  $('end').value = clip.end == null ? '' : timeLabel(clip.end, true);
  $('end').placeholder = ready ? timeLabel(duration, true) : 'Full video';
  for (const id of ['start-range', 'end-range']) $(id).max = duration;
  $('start-range').value = clip.trim;
  $('end-range').value = clip.end ?? duration;
  $('seek').min = clip.trim; $('seek').max = endTime() === Infinity ? duration : endTime();
  $('cut-summary').textContent = ready ? `${timeLabel(endTime() - clip.trim)} kept · ${timeLabel((endTime() - clip.trim) / speed)} at ${speed}×` : 'Cutoffs apply as you watch.';
  updateClock();
}
function updateClock() {
  if (!ready) return;
  $('clock').textContent = `${timeLabel(currentTime())} / ${timeLabel(durations.get(currentClip().id))}`;
  $('seek').value = currentTime();
  $('play').textContent = isPlaying() ? 'Pause' : finished ? 'Replay' : 'Play';
}
async function startPlayback() {
  if (!ready) return;
  const token = generation, active = player();
  if (finished || currentTime() >= endTime() - 0.1) { finished = false; seek(currentClip().trim); }
  // Wistia can pause while applying the initial saved cutoff. Finish that seek
  // before playing, so one user click reliably starts a trimmed lesson.
  if (seekTarget !== null) await new Promise(resolve => {
    const done = () => { clearTimeout(timer); active.removeEventListener('seeked', done); resolve(); };
    const timer = setTimeout(done, 2000);
    active.addEventListener('seeked', done, { once: true });
  });
  if (!ready || token !== generation) return;
  try { await active.play(); message('player-feedback', ''); }
  catch { message('player-feedback', 'Press Play to start the video.', true); }
  updateClock();
}
function completeClip() {
  if (finished || !ready) return;
  finished = true; pause();
  if (selected < clips.length - 1) playClip(selected + 1, true);
  else { message('player-feedback', 'Unit finished. Replay this video or choose another unit.'); updateClock(); }
}
function enforceCuts() {
  if (!ready || !currentClip()) return;
  settleSeek();
  if (seekTarget !== null) { updateClock(); return; }
  if (currentTime() < currentClip().trim - 0.08) seek(currentClip().trim);
  if (isPlaying() && currentTime() >= endTime() - 0.04) completeClip();
  else if (!isPlaying() && currentTime() > endTime() + 0.1) seek(endTime());
  updateClock();
}
function playClip(index, autoplay = false, resumeTime = null) {
  if (index < 0 || index >= clips.length) return;
  checkpoint(); pause(); clearTimeout(loadTimer);
  ready = false; loading = true; finished = false; seekTarget = null; selected = index;
  const clip = currentClip();
  const loadId = ++generation;
  // A fresh player avoids replacement events racing the old media's saved seek.
  apEvents?.abort();
  apHost.replaceChildren(); apPlayer = null;
  video.pause(); video.removeAttribute('src'); video.load();
  $('empty-state').hidden = true;
  $('current-title').textContent = clip.name;
  $('clock').textContent = '0:00 / 0:00';
  $('original').hidden = !clip.apUrl; if (clip.apUrl) $('original').href = clip.apUrl;
  message('player-feedback', 'Loading video…');
  const markReady = () => {
    if (loadId !== generation || currentClip() !== clip || ready) return;
    const duration = Number(player().duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (apPlayer && apPlayer.readyState < 2) return;
    durations.set(clip.id, duration);
    if (clip.trim >= Math.min(clip.end ?? duration, duration)) {
      clip.trim = 0; clip.end = null; queueSave();
      message('player-feedback', 'The video length changed. Its cutoffs were reset.');
    } else message('player-feedback', '');
    ready = true; loading = false; clearTimeout(loadTimer);
    const start = Number.isFinite(resumeTime) && resumeTime < endTime() - 0.1
      ? Math.max(clip.trim, resumeTime) : clip.trim;
    if (start > 0) seek(start);
    try { player().playbackRate = speed; } catch { message('player-feedback', 'This browser cannot use that playback speed.', true); }
    renderControls(); renderQueue(); renderLibrary();
    if (autoplay) startPlayback();
  };
  if (source === 'ap') {
    video.hidden = true; apHost.hidden = false;
    const element = document.createElement('wistia-player'); apPlayer = element;
    apEvents = new AbortController();
    const listen = (event, callback) => element.addEventListener(event, callback, { signal: apEvents.signal });
    element.setAttribute('media-id', clip.id);
    element.setAttribute('resumable', 'false'); element.setAttribute('muted', String(muted));
    element.setAttribute('player-color', '444444'); element.setAttribute('playback-rate', String(speed));
    element.setAttribute('preload', 'auto');
    // api-ready can fire before play() is usable. Enable controls when media is ready.
    for (const event of ['loaded-data', 'can-play']) listen(event, markReady);
    listen('time-update', () => { if (apPlayer === element) { markReady(); enforceCuts(); } });
    listen('seeked', () => { settleSeek(); updateClock(); checkpoint(); });
    listen('ended', () => { if (apPlayer === element) completeClip(); });
    for (const event of ['play', 'pause']) listen(event, () => { if (apPlayer === element) { updateClock(); if (event === 'pause') checkpoint(); } });
    listen('play', () => {
      if (apPlayer !== element) return;
      if (finished) { finished = false; seek(clip.trim); }
      enforceCuts();
    });
    listen('mute-change', () => { if (apPlayer === element) muted = element.muted; });
    listen('rate-change', () => { if (apPlayer === element && ready) rememberSpeed(Number(element.playbackRate)); });
    if (!document.querySelector(`script[data-media-id="${clip.id}"]`)) {
      const script = document.createElement('script'); script.src = `https://fast.wistia.com/embed/${clip.id}.js`;
      script.type = 'module'; script.async = true; script.dataset.mediaId = clip.id; document.head.append(script);
    }
    apHost.append(element);
  } else {
    video.hidden = false; apHost.hidden = true; video.muted = muted;
    video.onloadedmetadata = markReady; video.src = clip.url; video.load();
  }
  loadTimer = setTimeout(() => {
    if (loadId === generation && currentClip() === clip && !ready) {
      loading = false; renderControls(); renderQueue(); renderLibrary();
      message('player-feedback', source === 'ap' ? 'The video could not load. Check your connection or open it in AP Classroom. Click its title to retry.' : 'This file could not load. Try an MP4 or WebM file. Click its title to retry.', true);
    }
  }, 20000);
  renderControls(); renderQueue(); renderLibrary();
}
function queueSave() {
  dirty = true; revision++; message('save-feedback', 'Saving…');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 250);
}
function saveProject() {
  clearTimeout(saveTimer);
  if (!dirty) return saveChain;
  const version = revision;
  const payload = { libraryId, items: clips.map(({ id, trim, end }) => ({ id, trim, end })) };
  saveChain = saveChain.catch(() => false).then(async () => {
    try {
      await api('/api/project', payload);
      if (version === revision) { dirty = false; message('save-feedback', 'Saved'); }
      return true;
    } catch (error) { message('save-feedback', `Not saved. ${error.message}`, true); return false; }
  });
  return saveChain;
}
async function refresh() {
  const data = await api('/api/project');
  checkpoint(); pause(); ready = false; loading = false; clearTimeout(loadTimer);
  clips = data.clips; source = data.source; libraryId = data.libraryId; libraries = data.libraries; selected = -1;
  $('folder').value = data.folder; renderLibrary();
  if (clips.length) {
    const place = stored(`ap-viewer-place:${libraryId}`);
    const index = clips.findIndex(clip => clip.id === place?.id);
    playClip(index >= 0 ? index : 0, false, index >= 0 ? place.time : null);
  }
  else {
    apEvents?.abort(); apHost.replaceChildren(); apPlayer = null;
    video.removeAttribute('src'); video.load(); video.hidden = true; apHost.hidden = true;
    $('empty-state').hidden = false; $('current-title').textContent = 'Choose a unit to begin'; $('original').hidden = true;
    message('player-feedback', ''); renderControls(); renderQueue();
  }
  showExport(data.export);
}
async function changeLibrary(key) {
  if (switching) return;
  const wasReady = ready;
  checkpoint(); switching = true; pause(); ready = false; renderControls(); renderLibrary();
  try {
    if (!await saveProject()) throw new Error('Save your changes before switching units. Press Refresh to retry.');
    await api('/api/select', { libraryId: key }); await refresh();
    message('library-feedback', ''); message('save-feedback', '');
  } catch (error) { ready = wasReady; renderControls(); message('library-feedback', error.message, true); }
  finally { switching = false; renderLibrary(); }
}
function setCut(kind, value) {
  if (!ready) return;
  const clip = currentClip(), duration = durations.get(clip.id);
  value = value == null ? null : Math.round(value * 10) / 10;
  const start = kind === 'trim' ? value : clip.trim;
  const end = kind === 'end' ? value : clip.end;
  if (!Number.isFinite(start) || start < 0 || start >= (end ?? duration) || end != null && (!Number.isFinite(end) || end > duration || end <= start)) {
    message('player-feedback', 'Use seconds or m:ss. Start must come before end, within this video.', true); renderControls(); return;
  }
  clip[kind] = value; finished = false;
  if (currentTime() < start || currentTime() >= (end ?? duration)) seek(start);
  message('player-feedback', ''); renderControls(); renderQueue(); queueSave();
}
function rememberSpeed(value) {
  if (!Number.isFinite(value) || value < 0.25 || value > 16) return;
  speed = value;
  if (document.activeElement !== $('speed')) $('speed').value = value;
  store('ap-viewer-speed', value);
  if (ready) $('cut-summary').textContent = `${timeLabel(endTime() - currentClip().trim)} kept · ${timeLabel((endTime() - currentClip().trim) / speed)} at ${speed}×`;
}
function applySpeed() {
  const value = Number($('speed').value);
  if (!Number.isFinite(value) || value < 0.25 || value > 16) {
    message('player-feedback', 'Choose a speed from 0.25 to 16.', true); return;
  }
  try { if (ready) player().playbackRate = value; rememberSpeed(value); message('player-feedback', ''); }
  catch { message('player-feedback', 'This browser cannot use that playback speed.', true); $('speed').value = speed; }
}
async function loadFolder() {
  try {
    if (!await saveProject()) return;
    await api('/api/folder', { folder: $('folder').value }); await refresh();
    if (clips.length) $('add-dialog').close();
    else message('folder-feedback', 'No videos found in this folder. Choose a folder containing MP4 or WebM files.');
  } catch (error) { message('folder-feedback', error.message, true); }
}
function showExport(status) {
  $('export').hidden = source === 'ap'; $('export').disabled = !clips.length || status.state === 'running';
  message('export-status', status.state === 'running' ? 'Exporting…' : status.state === 'done' ? `Saved: ${status.file}` : status.state === 'error' ? status.message : '', status.state === 'error');
  if (status.state === 'running' && !exportTimer) exportTimer = setInterval(async () => {
    try {
      const result = await api('/api/export');
      if (result.state !== 'running') { clearInterval(exportTimer); exportTimer = null; }
      showExport(result);
    } catch (error) { clearInterval(exportTimer); exportTimer = null; message('export-status', error.message, true); }
  }, 1200);
}

// The bookmark reads metadata from the course the user has already opened.
function collectAPCourse(base) {
  try {
    if (location.hostname !== 'apclassroom.collegeboard.org') throw new Error('Open an AP Classroom video, then click this bookmark.');
    const button = document.querySelector('button[data-index]');
    if (!button) throw new Error('Open a video in your course first, then click this bookmark again.');
    let fiber = button[Object.keys(button).find((key) => key.startsWith('__reactFiber$'))];
    while (fiber && !Array.isArray(fiber.memoizedProps?.allAvailableVideoResources)) fiber = fiber.return;
    const resources = fiber?.memoizedProps?.allAvailableVideoResources;
    if (!resources?.length) throw new Error('Could not read the course video list. Keep the video open and try again.');
    const courseId = location.pathname.split('/')[1];
    const unit = new URL(location.href).searchParams.get('unit');
    const clips = resources.filter((item) => /^\d{1,2}$/.test(String(item.unitId)) && /^[A-Za-z0-9]{6,30}$/.test(item.url) && item.displayName)
      .map((item) => ({ id: item.url, name: item.displayName, unit: String(item.unitId) }));
    if (!clips.length) throw new Error('No videos found in this course.');
    const courseName = document.title.split(/ Unit \d+/)[0] || 'AP Classroom';
    // Same-tab navigation works even when a browser blocks popups.
    location.assign(base + '/#ap-import=' + encodeURIComponent(JSON.stringify({ courseId, courseName, unit, clips })));
  } catch (error) { alert(`AP video viewer: ${error.message}`); }
}
async function initialize() {
  try {
    if (location.hash.startsWith('#ap-import=')) {
      const payload = JSON.parse(decodeURIComponent(location.hash.slice(11)));
      const result = await api('/api/ap-import', payload);
      history.replaceState(null, '', '/');
      message('library-feedback', `Added ${result.units} units, ${result.count} videos.`);
    }
    await refresh();
  } catch (error) { message('library-feedback', `Could not load videos. ${error.message}`, true); }
}
const bookmark = `javascript:${encodeURIComponent(`(${collectAPCourse.toString()})(${JSON.stringify(location.origin)})`)}`;
$('import-course').setAttribute('href', bookmark);
$('import-course').addEventListener('click', (event) => { event.preventDefault(); message('ap-feedback', 'Drag this link to your bookmarks bar, then click the saved bookmark on an AP Classroom video page.'); });
$('copy-import').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(bookmark); message('ap-feedback', 'Copied. Create a bookmark and paste this into its URL field.'); }
  catch { message('ap-feedback', 'Copy was blocked. Drag Add to AP viewer to your bookmarks bar instead.', true); }
});
for (const id of ['manage', 'empty-add']) $(id).addEventListener('click', () => $('add-dialog').showModal());
$('close-dialog').addEventListener('click', () => $('add-dialog').close());
$('course').addEventListener('change', () => changeLibrary(libraries.find((entry) => entry.courseId === $('course').value).id));
$('unit').addEventListener('change', () => changeLibrary($('unit').value));
$('refresh').addEventListener('click', async () => {
  try { if (await saveProject()) { await refresh(); message('library-feedback', ''); } }
  catch (error) { message('library-feedback', error.message, true); }
});
$('play').addEventListener('click', () => isPlaying() ? pause() : startPlayback());
$('previous').addEventListener('click', () => playClip(selected - 1, true));
$('next').addEventListener('click', () => playClip(selected + 1, true));
$('seek').addEventListener('input', () => { finished = false; seek(Number($('seek').value)); updateClock(); });
$('trim').addEventListener('change', () => setCut('trim', parseTime($('trim').value)));
$('end').addEventListener('change', () => setCut('end', $('end').value.trim() ? parseTime($('end').value) : null));
$('start-range').addEventListener('input', () => setCut('trim', Math.min(Number($('start-range').value), endTime() - 0.2)));
$('end-range').addEventListener('input', () => setCut('end', Math.max(Number($('end-range').value), currentClip().trim + 0.2)));
$('set-start').addEventListener('click', () => setCut('trim', currentTime()));
$('set-end').addEventListener('click', () => setCut('end', currentTime()));
$('reset').addEventListener('click', () => { currentClip().trim = 0; currentClip().end = null; finished = false; renderControls(); renderQueue(); queueSave(); message('player-feedback', ''); });
$('speed').value = speed; $('speed').addEventListener('input', applySpeed); $('speed').addEventListener('change', applySpeed);
$('use-folder').addEventListener('click', loadFolder);
$('browse').addEventListener('click', async () => {
  try { const result = await api('/api/choose-folder', {}); if (result.folder) { $('folder').value = result.folder; await loadFolder(); } }
  catch (error) { message('folder-feedback', error.message, true); }
});
$('export').addEventListener('click', async () => {
  if (!await saveProject()) return;
  try { showExport(await api('/api/export', {})); }
  catch (error) { message('export-status', error.message, true); }
});
video.addEventListener('timeupdate', () => { if (!apPlayer) enforceCuts(); });
video.addEventListener('seeking', () => { if (!apPlayer) enforceCuts(); });
video.addEventListener('ended', () => { if (!apPlayer) completeClip(); });
video.addEventListener('play', () => { if (!apPlayer) { if (finished) { finished = false; seek(currentClip().trim); } updateClock(); } });
video.addEventListener('pause', () => { if (!apPlayer) updateClock(); });
video.addEventListener('volumechange', () => { if (!apPlayer) muted = video.muted; });
video.addEventListener('ratechange', () => { if (!apPlayer && ready) rememberSpeed(video.playbackRate); });
video.addEventListener('error', () => { if (!apPlayer && currentClip()) message('player-feedback', 'This file could not play. Try MP4 or WebM.', true); });
// Check the cutoff between time-update events, including at high speeds.
setInterval(() => { if (isPlaying()) enforceCuts(); }, 50);
document.addEventListener('keydown', (event) => {
  if (event.composedPath().some((element) => ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'WISTIA-PLAYER', 'VIDEO'].includes(element.tagName)) || $('add-dialog').open || !ready) return;
  if (event.code === 'Space') { event.preventDefault(); isPlaying() ? pause() : startPlayback(); }
  if (event.code === 'ArrowLeft') { event.preventDefault(); seek(currentTime() - 5); }
  if (event.code === 'ArrowRight') { event.preventDefault(); seek(currentTime() + 5); }
});
setInterval(checkpoint, 1000);
video.addEventListener('pause', checkpoint);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { checkpoint(); saveProject(); }
});
window.addEventListener('pagehide', () => {
  checkpoint();
  if (dirty) fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ libraryId, items: clips.map(({ id, trim, end }) => ({ id, trim, end })) }), keepalive: true }).catch(() => {});
});
window.addEventListener('hashchange', initialize);
renderControls(); initialize();
