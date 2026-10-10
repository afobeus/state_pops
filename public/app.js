import { createGame, step, dispatch, recordResult, DEFAULT_PROFILE, validateSave, TOTAL_LEVELS, COLORS, MAPS, mapInfo, random } from './engine.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titles = ['Первые рубежи', 'Встречный ветер', 'Три берега', 'Перекрёсток', 'Линия фронта', 'За горизонтом', 'Четвёртая сила', 'Тихая гавань', 'Остров надежды', 'Точка опоры', 'Большой переход', 'Новый рубеж', 'Дальний восток', 'Союз островов', 'Земли рассвета', 'Высокая ставка', 'Золотой берег', 'В сердце карты', 'Последний бастион', 'Обратный отсчёт', 'Сила империи', 'Решающая битва', 'Все пути', 'Твоя империя'];
const chapters = ['Начало пути', 'Новые горизонты', 'Время империи', 'Последний рубеж'];
let profile = DEFAULT_PROFILE(), game = createGame(), user = null;
let version = 0, updatedAt = null, dirty = false, revision = 0, saving = null, conflict = false, authUnknown = false, accountReady = false, syncError = false;
let selected = [], portrait = matchMedia('(max-width:650px)').matches, dragging = null, suppressClick = false;
let refs = [], lastFrame = 0, lastRender = 0, toastTimeout, audio, currentModal = '', resultShown = false;
let multiplayer = null, campaignGame = null, roomStream = null, snapshotTime = 0, renderedRoomContent = '';
const fleetElements = new Map(), SVG_NS = 'http://www.w3.org/2000/svg';
const myOwner = () => multiplayer ? multiplayer.players.find(p => p.id === user?.id)?.owner ?? -2 : 0;
const localKey = () => user ? `stateio.account.${user.id}` : 'stateio.guest';
function snapshot() { return JSON.parse(JSON.stringify({ schema: 1, profile, game: campaignGame ?? game })); }
function markDirty() { dirty = true; revision++; }
function localSave() {
  try { localStorage.setItem(localKey(), JSON.stringify({ save: snapshot(), version, updatedAt, dirty })); }
  catch { setSync('Хранилище устройства недоступно', 'error'); }
}
function loadSnapshot(save) {
  const loaded = validateSave(save); profile = loaded.profile;
  if (multiplayer) { campaignGame = loaded.game; if (campaignGame.status === 'playing') campaignGame.status = 'paused'; applySettings(); return; }
  game = loaded.game;
  if (game.status === 'playing') game.status = 'paused';
  selected = []; resultShown = game.resultRecorded; dragging = null;
  applySettings(); buildMap(); render();
}
function loadLocal() {
  try { const raw = localStorage.getItem(localKey()); if (!raw) return false; const stored = JSON.parse(raw); loadSnapshot(stored.save); version = stored.version || 0; updatedAt = stored.updatedAt; dirty = Boolean(stored.dirty); if (dirty) revision++; return true; }
  catch { return false; }
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimeout); toastTimeout = setTimeout(() => $('toast').hidden = true, 4500); }
function setSync(text, className = '') { $('syncText').textContent = text; $('syncStatus').className = `sync-pill ${className}`; }
async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Не удалось выполнить запрос'), { status: response.status, data });
  return data;
}
function userUI() {
  $('accountName').textContent = user ? user.name : 'Войти в аккаунт';
  $('avatar').textContent = user ? [...user.name][0].toUpperCase() : 'Г';
  $('cloudTitle').textContent = user ? 'Твоя империя всегда рядом.' : 'Одна империя. Любое устройство.';
  $('cloudDescription').textContent = user ? 'Прогресс сохраняется в аккаунте. Продолжай игру с любого устройства.' : 'Войди, чтобы сохранить прогресс и продолжить игру на телефоне.';
  try { if (user) localStorage.setItem('stateio.lastUser', JSON.stringify(user)); else localStorage.removeItem('stateio.lastUser'); } catch { /* Browser storage may be restricted. */ }
}
function syncLabel() {
  if (conflict) return setSync('Конфликт сохранений', 'error');
  if (authUnknown) return setSync('Сервер недоступен', 'error');
  if (!user) return setSync('Локальное сохранение');
  if (!navigator.onLine) return setSync('Нет сети · сохранено на устройстве', 'error');
  if (saving) return setSync('Синхронизация…');
  if (syncError) return setSync('Нет связи · сохранено на устройстве', 'error');
  if (dirty) return setSync('Есть несохранённые изменения');
  setSync('Сохранено в аккаунте', 'synced');
}
async function saveCloud({ quiet = true, force = false } = {}) {
  localSave();
  if (!user || !accountReady || conflict || !navigator.onLine || (!dirty && !force)) { syncLabel(); return !conflict && !dirty; }
  if (saving) { await saving; if (!conflict && dirty) return saveCloud({ quiet, force }); return !dirty; }
  const capturedRevision = revision, capturedUser = user.id;
  const payload = { version, save: snapshot() };
  saving = (async () => {
    try {
      const data = await api('save', { method: 'PUT', body: JSON.stringify(payload) });
      if (user?.id !== capturedUser) return;
      version = data.version; updatedAt = data.updatedAt; syncError = false;
      if (capturedRevision === revision) dirty = false;
      localSave();
      if (!quiet) toast('Прогресс сохранён в аккаунте');
    } catch (e) {
      if (e.status === 409) { conflict = true; pauseGame(); openConflict(); }
      else if (e.status === 401) { authUnknown = true; accountReady = false; pauseGame(); toast('Сессия завершилась. Войди снова, чтобы синхронизировать прогресс.'); }
      else { syncError = true; setSync('Сохранено на устройстве · нет связи', 'error'); if (!quiet) toast('Сервер недоступен. Прогресс сохранён на этом устройстве.'); }
    }
  })();
  syncLabel(); await saving; saving = null;
  if (!authUnknown) syncLabel();
  return !dirty && !conflict;
}
async function initializeAccount() {
  try {
    const data = await api('me'); authUnknown = false;
    if (data.user) {
      user = data.user; userUI();
      const local = (() => { try { return JSON.parse(localStorage.getItem(localKey())); } catch { return null; } })();
      const cloud = await api('save'); accountReady = true; syncError = false;
      version = cloud.version; updatedAt = cloud.updatedAt;
      if (cloud.save) {
        if (local?.save && local.dirty && local.version === cloud.version && JSON.stringify(local.save) !== JSON.stringify(cloud.save)) {
          loadSnapshot(local.save); markDirty(); toast('Продолжаем сохранение с этого устройства'); await saveCloud();
        } else if (local?.save && local.dirty && local.version !== cloud.version && JSON.stringify(local.save) !== JSON.stringify(cloud.save)) {
          loadSnapshot(local.save); markDirty(); conflict = true; openConflict();
        } else { loadSnapshot(cloud.save); dirty = false; revision++; }
      } else {
        if (!loadLocal()) { profile = DEFAULT_PROFILE(); game = createGame(); buildMap(); render(); }
        version = 0; markDirty(); await saveCloud();
      }
      localSave();
    } else if (user) {
      localSave(); user = null; accountReady = false; version = 0; updatedAt = null; dirty = false;
      profile = DEFAULT_PROFILE(); game = createGame(); if (!loadLocal()) { buildMap(); render(); }
    }
    userUI(); syncLabel();
  } catch { authUnknown = true; accountReady = false; setSync('Сервер недоступен', 'error'); }
}
function projected(n) { return portrait ? { x: n.y, y: n.x } : { x: n.x * 1.2, y: n.y * .6 + 10 }; }
function clip(polygon, a, b, c) {
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    const dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp <= 0) !== (dq <= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}
function buildMap() {
  const w = portrait ? 590 : 920, h = portrait ? 780 : 370;
  $('map').setAttribute('viewBox', `0 0 ${w} ${h}`);
  const rect = $('map').querySelector('rect'); rect.setAttribute('width', w); rect.setAttribute('height', h);
  const info = mapInfo(game), islands = game.mapVersion === 2 && ['islands', 'stars'].includes(info.kind);
  const outline = (game.mapVersion === 2 ? info.outline : [[45,95],[120,42],[420,38],[620,60],[725,156],[735,405],[658,524],[440,547],[135,530],[42,418],[30,223]]).map(([x,y]) => { const p = projected({x,y}); return [p.x,p.y]; });
  fleetElements.clear(); $('fleetLayer').replaceChildren();
  refs = [];
  $('terrain').innerHTML = game.nodes.map((n, i) => {
    const center = projected(n);
    let poly = outline;
    if (islands) {
      const rng = random(game.level * 71 + i * 149), nearest = Math.min(...game.nodes.filter(q => q.id !== i).map(q => Math.hypot(n.x-q.x,n.y-q.y)));
      const radius = Math.min(info.kind === 'stars' ? 66 : 77, nearest * .44), vertices = info.kind === 'stars' ? 10 : 7 + i % 3;
      poly = Array.from({ length: vertices }, (_, v) => { const a = v * Math.PI * 2 / vertices, r = radius * (info.kind === 'stars' ? v % 2 ? .63 : 1 : .82 + rng() * .18); const p = projected({ x: n.x + Math.cos(a)*r, y: n.y + Math.sin(a)*r }); return [p.x,p.y]; });
    }
    for (const other of islands ? [] : game.nodes) {
      if (other.id === n.id) continue;
      const q = projected(other), a = q.x - center.x, b = q.y - center.y;
      poly = clip(poly, a, b, (q.x * q.x + q.y * q.y - center.x * center.x - center.y * center.y) / 2);
    }
    const path = poly.map(([x, y]) => `${(center.x + (x - center.x) * .94).toFixed(1)},${(center.y + (y - center.y) * .94).toFixed(1)}`).join(' ');
    return `<g class="territory" data-node="${i}" role="button" tabindex="0" aria-label=""><polygon class="province" points="${path}"/><circle class="selected-ring" cx="${center.x}" cy="${center.y}" r="32"/><circle class="node-circle" cx="${center.x}" cy="${center.y}" r="23"/><text class="count" x="${center.x}" y="${center.y}">${Math.floor(n.units)}</text>${n.owner === myOwner() && game.time === 0 ? `<text class="crown" x="${center.x}" y="${center.y - 40}">ТВОЯ БАЗА</text>` : ''}</g>`;
  }).join('');
  refs = [...$('terrain').children].map(el => ({ el, province: el.querySelector('.province'), circle: el.querySelector('.node-circle'), count: el.querySelector('.count') }));
  renderMap();
}
function renderMap() {
  const fills = ['#a4c5f4', '#edb0a6', '#e7d497', '#ceb9e0'];
  for (const n of game.nodes) {
    const r = refs[n.id]; if (!r) continue;
    r.province.setAttribute('fill', n.owner < 0 ? '#dbe3db' : fills[n.owner]);
    r.circle.setAttribute('stroke', n.owner < 0 ? '#c7d3c6' : COLORS[n.owner]);
    r.count.textContent = Math.floor(n.units);
    r.el.classList.toggle('selected', selected.includes(n.id) && n.owner === myOwner());
    r.el.classList.toggle('launching', game.orders?.some(o => o.from === n.id));
    r.el.setAttribute('aria-label', `Территория ${n.id + 1}, ${n.owner === myOwner() ? 'твоя' : n.owner < 0 ? 'свободная' : 'соперник'}, армия ${Math.floor(n.units)}`);
  }
}
function animateFleets(now) {
  const present = new Set(), extrapolation = multiplayer?.state === 'playing' && multiplayer.connected ? Math.min(.18, (now - snapshotTime) / 1000) : 0;
  for (const f of game.fleets) {
    const from = projected(game.nodes[f.from]), to = projected(game.nodes[f.to]);
    const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx,dy);
    for (let j = 0; j < f.units; j++) {
      const key = `${f.id}:${j}`; present.add(key);
      let el = fleetElements.get(key);
      if (!el) { el = document.createElementNS(SVG_NS, 'circle'); el.setAttribute('r', '3.2'); el.setAttribute('fill', COLORS[f.owner]); el.setAttribute('class', 'fleet-dot'); $('fleetLayer').append(el); fleetElements.set(key, el); }
      const t = Math.max(0, Math.min(1, f.progress + extrapolation / f.duration - j * .004));
      const lane = ((f.id + j) % 4 - 1.5) * 6;
      const bend = Math.pow(Math.sin(Math.PI * t), .3) * lane;
      const margin = Math.min(.3, 26 / distance), along = margin + t * (1 - margin * 2);
      el.setAttribute('cx', (from.x + dx * along - dy / distance * bend).toFixed(2));
      el.setAttribute('cy', (from.y + dy * along + dx / distance * bend).toFixed(2));
      el.setAttribute('opacity', Math.min(1, t * 24, (1 - t) * 24).toFixed(2));
    }
  }
  for (const [key, el] of fleetElements) if (!present.has(key)) { el.remove(); fleetElements.delete(key); }
}
function formatTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function render() {
  const level = game.level, chapter = Math.floor((level - 1) / 6);
  $('levelChip').textContent = String(level).padStart(2, '0');
  $('levelName').textContent = titles[level - 1]; $('levelSubtitle').textContent = `Глава ${chapter + 1} · ${chapters[chapter]}`;
  $('operationNumber').textContent = String(level).padStart(2, '0');
  $('chapterNumber').textContent = String(chapter + 1).padStart(2, '0'); $('chapterTitle').textContent = chapters[chapter];
  $('chapterDescription').textContent = ['Даже большая империя начинается с маленькой территории.', 'Новые земли, новые соперники. Твоя стратегия становится сильнее.', 'Четыре армии. Одна карта. Время сделать решающий ход.', 'Впереди самые сложные битвы. Победа уже близко.'][chapter];
  const completed = Object.keys(profile.best).length;
  $('campaignProgress').textContent = `${completed} / ${TOTAL_LEVELS}`; $('progressFill').style.width = `${completed / TOTAL_LEVELS * 100}%`;
  $('timer').textContent = formatTime(game.time);
  $('mapName').textContent = mapInfo(game).name.toUpperCase();
  const mine = game.nodes.filter(n => n.owner === myOwner());
  $('territoryCount').textContent = mine.length; $('territoryTotal').textContent = ` / ${game.nodes.length}`;
  $('armyCount').textContent = Math.floor(mine.reduce((s, n) => s + n.units, 0) + game.fleets.filter(f => f.owner === myOwner()).reduce((s, f) => s + f.units, 0));
  $('winsCount').textContent = profile.wins; $('purpleKey').hidden = game.level <= 6;
  const distribution = Array.from({ length: 5 }, (_, i) => game.nodes.filter(n => n.owner === i - 1).length);
  $('factionBar').innerHTML = distribution.map((n, i) => `<span style="width:${n / game.nodes.length * 100}%;background:${i ? COLORS[i - 1] : '#d5dfd5'}"></span>`).join('');
  const states = { ready: 'ПОДГОТОВКА', playing: 'В БОЮ', paused: 'ПАУЗА', won: 'ПОБЕДА', lost: 'ПОРАЖЕНИЕ' };
  $('battleState').textContent = states[game.status];
  $('pauseButton').innerHTML = icon(game.status === 'playing' ? 'pause' : 'play');
  $('pauseButton').setAttribute('aria-label', game.status === 'playing' ? 'Приостановить игру' : 'Продолжить игру');
  $('startOverlay').hidden = game.status === 'playing';
  if (game.status !== 'playing') {
    $('overlayTitle').textContent = { ready: 'Всё начинается с одной земли.', paused: 'Империя может подождать.', won: 'Эта карта — твоя.', lost: 'Новая тактика. Новый шанс.' }[game.status];
    $('overlayText').textContent = { ready: 'Синие территории — твои. Отправляй отряды на соседние земли и захвати карту.', paused: 'Твоя партия на паузе. Продолжи, когда будешь готов сделать следующий ход.', won: game.level === TOTAL_LEVELS ? 'Ты завершил кампанию. Переиграй любимые уровни и улучши время.' : 'Все соперники побеждены. Впереди новые земли и новые возможности.', lost: 'Соперники захватили твои земли. Попробуй укрепить армию и атаковать слабые территории.' }[game.status];
    $('startButton').innerHTML = `${{ ready: 'Начать наступление', paused: 'Продолжить битву', won: game.level === TOTAL_LEVELS ? 'Карта кампании' : 'Следующая операция', lost: 'Попробовать снова' }[game.status]} ${icon('arrow')}`;
  }
  selected = selected.filter(id => game.nodes[id]?.owner === myOwner());
  $('selectionText').textContent = selected.length ? `Территорий: ${selected.length} · отправится ${selected.reduce((s, id) => s + Math.floor(game.nodes[id].units), 0)}` : 'Выбери свою территорию';
  $('selectionHint').textContent = selected.length ? 'Нажми на цель, чтобы отправить подкрепление' : 'Затем нажми на цель или перетащи отряд';
  renderMap();
  $('map').setAttribute('aria-label', 'Карта территорий. Выберите свою территорию, затем цель.');
  document.querySelector('.map-legend .blue').style.background = COLORS[myOwner()] || COLORS[0];
  document.querySelector('.faction-keys .blue').style.background = COLORS[myOwner()] || COLORS[0];
  $('restartButton').setAttribute('aria-label', multiplayer ? 'Открыть участников комнаты' : 'Перезапустить уровень');
  $('restartButton').innerHTML = icon(multiplayer ? 'user' : 'restart');
  document.querySelectorAll('.nav-item[data-view]').forEach(el => { const active = el.dataset.view === (multiplayer ? 'multiplayer' : 'game'); el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (multiplayer) renderMultiplayer();
}
function applySettings() { document.body.classList.toggle('reduced-motion', profile.settings.reducedMotion); }
function sound(kind = 'send') {
  if (!profile.settings.sound) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)(); audio.resume();
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(kind === 'win' ? 523 : 420, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'win' ? 1046 : 700, audio.currentTime + .12);
    gain.gain.setValueAtTime(.035, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .18);
    oscillator.start(); oscillator.stop(audio.currentTime + .19);
  } catch { /* Audio is optional. */ }
}
function pauseGame() { if (!multiplayer && game.status === 'playing') { game.status = 'paused'; markDirty(); render(); localSave(); } }
function startGame() {
  if (multiplayer) return openRoom();
  if (conflict) return openConflict();
  if (game.status === 'won') { if (game.level === TOTAL_LEVELS) return openCampaign(); return newLevel(game.level + 1, true); }
  if (game.status === 'lost') return newLevel(game.level, true);
  game.status = 'playing'; markDirty(); selected = []; lastFrame = performance.now(); render(); sound();
}
function newLevel(level, start = false) {
  if (multiplayer) return openRoom();
  game = createGame(level, profile.settings.difficulty); if (start) game.status = 'playing';
  selected = []; resultShown = false; markDirty(); buildMap(); render(); localSave(); void saveCloud();
}
function activateNode(id, multi = false) {
  if (multiplayer && (multiplayer.state !== 'playing' || !multiplayer.connected)) return toast('Дождись начала битвы и подключения к комнате');
  if (game.status !== 'playing') { if (game.status === 'ready' || game.status === 'paused') toast('Начни битву, чтобы отправить армию'); return; }
  const node = game.nodes[id]; if (!node) return;
  if (node.owner === myOwner() && (!selected.length || multi || selected.includes(id))) {
    selected = multi ? selected.includes(id) ? selected.filter(i => i !== id) : [...selected, id] : selected.includes(id) ? [] : [id];
  } else if (selected.length) {
    if (multiplayer) {
      const sources = selected.filter(i => game.nodes[i].owner === myOwner()); selected = [];
      void api(`rooms/${multiplayer.code}/dispatch`, { method: 'POST', body: JSON.stringify({ sources, target: id }) }).then(data => { if (data.sent) sound(); else toast('В гарнизоне пока нет бойцов'); }).catch(e => toast(e.message));
      render(); return;
    }
    const sent = dispatch(game, selected.filter(i => game.nodes[i].owner === myOwner()), id);
    if (sent) { markDirty(); sound(); selected = []; }
    else toast('Нужно больше бойцов, чтобы отправить отряд');
  } else toast('Сначала выбери свою территорию');
  render();
}
function mapPoint(event) {
  const pt = $('map').createSVGPoint(); pt.x = event.clientX; pt.y = event.clientY;
  return pt.matrixTransform($('map').getScreenCTM().inverse());
}
$('map').addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-node]'); if (!el || game.status !== 'playing') return;
  const id = Number(el.dataset.node); if (game.nodes[id].owner !== myOwner()) return;
  dragging = { id, x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
});
$('map').addEventListener('pointermove', e => {
  if (!dragging || dragging.pointerId !== e.pointerId) return;
  if (Math.hypot(e.clientX - dragging.x, e.clientY - dragging.y) < 7 && !dragging.moved) return;
  if (!dragging.moved) $('map').setPointerCapture(e.pointerId);
  dragging.moved = true;
  const from = projected(game.nodes[dragging.id]), to = mapPoint(e);
  $('routeLayer').innerHTML = `<path class="route-line" d="M${from.x},${from.y}L${to.x},${to.y}"/>`;
});
$('map').addEventListener('pointerup', e => {
  if (!dragging || dragging.pointerId !== e.pointerId) return;
  const drag = dragging; dragging = null; $('routeLayer').innerHTML = '';
  if ($('map').hasPointerCapture(e.pointerId)) $('map').releasePointerCapture(e.pointerId);
  if (!drag.moved) return;
  suppressClick = true; setTimeout(() => suppressClick = false, 0);
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]');
  if (el && Number(el.dataset.node) !== drag.id && game.nodes[drag.id].owner === myOwner()) {
    selected = [drag.id]; activateNode(Number(el.dataset.node));
  }
});
$('map').addEventListener('pointercancel', () => { dragging = null; $('routeLayer').innerHTML = ''; });
$('map').addEventListener('click', e => { if (suppressClick) return; const el = e.target.closest('[data-node]'); if (el) activateNode(Number(el.dataset.node), e.shiftKey); });
$('map').addEventListener('keydown', e => { if (['Enter', ' '].includes(e.key)) { const el = e.target.closest('[data-node]'); if (el) { e.preventDefault(); activateNode(Number(el.dataset.node), e.shiftKey); } } });
$('startButton').addEventListener('click', startGame);
$('pauseButton').addEventListener('click', () => { if (multiplayer) return openRoom(); if (game.status === 'playing') { pauseGame(); void saveCloud(); } else startGame(); });
$('restartButton').addEventListener('click', () => {
  if (multiplayer) return openRoom();
  pauseGame(); openModal('restart', `<h2 class="modal-title">Начать заново?</h2><p class="modal-description">Текущая битва будет сброшена. Пройденные уровни и достижения сохранятся.</p><div class="button-stack"><button class="primary-button" data-action="restart">Перезапустить уровень ${icon('restart')}</button><button class="secondary-button" data-action="close">Вернуться к партии</button></div>`);
});
function openModal(type, html, eyebrow = 'STATE.IO / ТВОЯ СТРАТЕГИЯ') {
  pauseGame(); void saveCloud(); currentModal = type;
  $('modalEyebrow').textContent = eyebrow; $('modalBody').innerHTML = html;
  if (!$('modal').open) $('modal').showModal();
}
function closeModal() { $('modal').close(); currentModal = ''; render(); }
$('closeModal').addEventListener('click', closeModal);
$('modal').addEventListener('click', e => { if (e.target === $('modal')) { const b = $('modal').getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) closeModal(); } });
$('modal').addEventListener('close', () => { currentModal = ''; render(); });
function openAuth(mode = 'login', error = '') {
  openModal('auth', `<h2 class="modal-title">Твоя империя. Твой аккаунт.</h2><p class="modal-description">Сохраняй кампанию и продолжай с того же места на телефоне, планшете или компьютере.</p><div class="auth-tabs"><button data-action="login-tab" class="${mode === 'login' ? 'active' : ''}">Войти</button><button data-action="register-tab" class="${mode === 'register' ? 'active' : ''}">Создать аккаунт</button></div><form id="authForm" data-mode="${mode}">${mode === 'register' ? '<label class="form-field">Имя командира<input name="name" autocomplete="nickname" minlength="2" maxlength="24" placeholder="Как тебя называть?" required></label>' : ''}<label class="form-field">Email<input name="email" type="email" autocomplete="email" maxlength="254" placeholder="commander@example.com" required></label><label class="form-field">Пароль<input name="password" type="password" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" minlength="10" maxlength="128" placeholder="Не менее 10 символов" required></label><p class="form-error" id="authError" role="alert">${escape(error)}</p><button class="primary-button full-width" type="submit">${mode === 'register' ? 'Создать аккаунт' : 'Войти в аккаунт'} ${icon('arrow')}</button></form><p class="form-note">Гостевой прогресс можно перенести в новый аккаунт.<br>Вход привязан к этому серверу игры.</p>`, 'STATE.IO / СОХРАНЕНИЯ');
}
function openAccount() {
  if (!user || authUnknown) return openAuth();
  openModal('account', `<h2 class="modal-title">Привет, ${escape(user.name)}.</h2><p class="modal-description">${escape(user.email)}<br>Войди в этот аккаунт по тому же адресу игры на другом устройстве, чтобы продолжить кампанию.</p><div class="account-summary"><div><span>Пройдено уровней</span><strong>${Object.keys(profile.best).length} / ${TOTAL_LEVELS}</strong></div><div><span>Последняя синхронизация</span><strong class="autosave-time">${updatedAt ? escape(new Date(updatedAt).toLocaleString('ru-RU')) : 'Ещё не сохранено'}</strong></div><div><span>Состояние</span><strong>${conflict ? 'Нужно выбрать версию' : dirty ? 'Ожидает синхронизации' : 'Сохранено в аккаунте'}</strong></div></div><div class="button-stack"><button class="primary-button" data-action="sync">${icon('cloud')} Синхронизировать сейчас</button><button class="secondary-button" data-action="reload-cloud">Загрузить с другого устройства</button></div><button class="danger-button" data-action="logout">Выйти из аккаунта</button>`, 'STATE.IO / ПРОФИЛЬ');
}
function openCampaign() {
  if (multiplayer) return openRoom();
  let html = '<h2 class="modal-title">Твоя карта побед.</h2><p class="modal-description">24 операции. Четыре главы. Одна империя.<br>Победи всех соперников, чтобы открыть следующий уровень.</p>';
  for (let chapter = 0; chapter < 4; chapter++) {
    html += `<h3 class="chapter-heading">0${chapter + 1} / ${chapters[chapter]}</h3><div class="campaign-grid">`;
    for (let i = chapter * 6 + 1; i <= (chapter + 1) * 6; i++) html += `<button class="level-button ${game.level === i ? 'current' : profile.best[i] !== undefined ? 'completed' : ''}" data-level="${i}" ${i > profile.unlocked ? 'disabled' : ''} aria-label="Уровень ${i}: ${titles[i - 1]}${i > profile.unlocked ? ', закрыт' : ''}" title="${titles[i - 1]}${profile.best[i] !== undefined ? ` · лучшее время ${formatTime(profile.best[i])}` : ''}">${i > profile.unlocked ? icon('lock') : String(i).padStart(2, '0')}${profile.best[i] !== undefined ? '<span class="mini-star">★</span>' : ''}</button>`;
    html += '</div>';
  }
  html += '<p class="help-foot">Выбор другого уровня заменит текущую партию. Повторное прохождение улучшает личное время.</p>';
  openModal('campaign', html, 'STATE.IO / КАМПАНИЯ');
}
function openAchievements() {
  const achievements = [
    ['Первый флаг', 'Выиграй свою первую битву', profile.wins >= 1, 'cup'],
    ['Исследователь', 'Пройди первые шесть операций', profile.unlocked >= 7, 'map'],
    ['Большая стратегия', 'Пройди двенадцать операций', profile.unlocked >= 13, 'game'],
    ['Молниеносный захват', 'Заверши любую операцию менее чем за 2 минуты', Object.values(profile.best).some(n => n < 120), 'spark'],
    ['Повелитель карты', 'Пройди все 24 операции', profile.best[24] !== undefined, 'cup']
  ];
  openModal('achievements', `<h2 class="modal-title">Каждая победа — история.</h2><p class="modal-description">Твои достижения в кампании. Продолжай играть, чтобы собрать их все.</p><div class="achievement-list">${achievements.map(([name, description, done, symbol]) => `<div class="achievement ${done ? 'unlocked' : ''}"><div class="medal">${icon(symbol)}</div><div><h3>${name}</h3><p>${description}</p></div><span>${done ? 'Получено' : icon('lock')}</span></div>`).join('')}</div>`, 'STATE.IO / ДОСТИЖЕНИЯ');
}
function openSettings() {
  openModal('settings', `<h2 class="modal-title">Твой стиль игры.</h2><p class="modal-description">Настройки сохраняются вместе с кампанией.</p><label class="form-field">Сложность новых партий<select id="difficultySetting"><option value="easy" ${profile.settings.difficulty === 'easy' ? 'selected' : ''}>Лёгкая — время подумать</option><option value="normal" ${profile.settings.difficulty === 'normal' ? 'selected' : ''}>Обычная — равные силы</option><option value="hard" ${profile.settings.difficulty === 'hard' ? 'selected' : ''}>Сложная — быстрые соперники</option></select></label><div class="setting-row"><div><h3>Звуковые сигналы</h3><p>Отправка отрядов и победы</p></div><label class="toggle"><input id="soundSetting" type="checkbox" aria-label="Звуковые сигналы" ${profile.settings.sound ? 'checked' : ''}><span></span></label></div><div class="setting-row"><div><h3>Меньше анимации</h3><p>Отключить декоративные переходы</p></div><label class="toggle"><input id="motionSetting" type="checkbox" aria-label="Меньше анимации" ${profile.settings.reducedMotion ? 'checked' : ''}><span></span></label></div><p class="form-note">Изменение сложности применяется при запуске нового уровня.<br>Партия автоматически ставится на паузу, если ты уходишь с вкладки.</p><button class="primary-button full-width" data-action="save-settings">Сохранить настройки ${icon('check')}</button>`, 'STATE.IO / НАСТРОЙКИ');
}
function openHelp() {
  openModal('help', `<h2 class="modal-title">Думай на шаг вперёд.</h2><p class="modal-description">Простое управление. Безграничная стратегия.</p><ol class="help-list"><li><h3>Собери свою армию</h3><p>На синих территориях автоматически появляются новые бойцы. Число в круге — размер гарнизона.</p></li><li><h3>Выбери цель</h3><p>Нажми на свою территорию, затем на цель. Или перетащи отряд от своей базы к другой земле. Всегда отправляется 100% текущего гарнизона: по четыре бойца каждые 0,1 секунды. Новые бойцы остаются на базе.</p></li><li><h3>Расширяй границы</h3><p>Каждый шарик — отдельный боец. Бойцы захватывают землю постепенно, уменьшая гарнизон при каждом прибытии. На свои земли можно отправлять подкрепления. Серые земли не наращивают армию.</p></li><li><h3>Захвати всю карту</h3><p>Победи все армии соперников и открой следующую операцию. Пока у соперника есть отряды в пути, битва продолжается.</p></li></ol><div class="help-foot">Компьютер: Shift + нажатие выбирает несколько баз. Enter или пробел активируют территорию с клавиатуры. Пробел вне карты ставит игру на паузу. На телефоне работают нажатия и перетаскивание.</div>`, 'STATE.IO / КАК ИГРАТЬ');
}
function renderMultiplayer() {
  const room = multiplayer, mine = myOwner(), won = room.game?.winner === mine;
  $('levelChip').textContent = 'VS'; $('levelName').textContent = 'Битва с друзьями';
  $('levelSubtitle').textContent = `Комната ${room.code} · игроков: ${room.players.length}`;
  $('battleState').textContent = !room.connected ? 'СВЯЗЬ…' : room.state === 'lobby' ? 'ЛОББИ' : room.state === 'finished' ? won ? 'ПОБЕДА' : 'БИТВА ОКОНЧЕНА' : 'ОНЛАЙН';
  $('pauseButton').innerHTML = icon('user'); $('pauseButton').setAttribute('aria-label', 'Открыть комнату');
  $('startOverlay').hidden = room.state === 'playing';
  if (room.state !== 'playing') {
    $('overlayTitle').textContent = room.state === 'lobby' ? 'Собираем командиров.' : won ? 'Эта карта — твоя.' : 'Победитель определён.';
    $('overlayText').textContent = room.state === 'lobby' ? `Отправь друзьям код ${room.code}. Создатель комнаты начинает битву, когда все подключатся.` : room.game?.winner == null ? 'Битва закончилась без победителя.' : `Победил ${room.players.find(p => p.owner === room.game.winner)?.name || 'командир'}. Можно создать новую комнату.`;
    $('startButton').innerHTML = `Открыть комнату ${icon('arrow')}`;
  }
  document.querySelector('.overlay-note').textContent = 'Онлайн-битва продолжается, пока вкладка скрыта.';
}
function restoreCampaign() {
  roomStream?.close(); roomStream = null; multiplayer = null;
  if (campaignGame) game = campaignGame; campaignGame = null;
  selected = []; document.querySelector('.overlay-note').textContent = 'Без таймера. Только твоя стратегия.';
  buildMap(); render(); localSave();
}
function enterRoom(room) {
  if (!multiplayer) { pauseGame(); localSave(); campaignGame = game; }
  roomStream?.close(); multiplayer = { ...room, connected: false };
  if (room.game) game = room.game;
  buildMap(); render(); openRoom();
  roomStream = new EventSource(`/api/rooms/${room.code}/stream`);
  roomStream.addEventListener('state', event => {
    const fresh = JSON.parse(event.data), wasLobby = multiplayer?.state === 'lobby', started = fresh.game && !multiplayer?.game;
    if (!multiplayer || fresh.code !== multiplayer.code) return;
    if (fresh.game) fresh.game.fleets = fresh.game.fleets.map(([id, from, to, owner, progress]) => ({ id, from, to, owner, progress, units: 1, duration: Math.hypot(fresh.game.nodes[to].x - fresh.game.nodes[from].x, fresh.game.nodes[to].y - fresh.game.nodes[from].y) / 105 }));
    multiplayer = { ...fresh, connected: true }; snapshotTime = performance.now();
    if (fresh.game) game = fresh.game;
    if (started) { selected = []; buildMap(); }
    render();
    if (wasLobby && fresh.state === 'playing' && currentModal === 'room') closeModal();
    else if (currentModal === 'room') updateRoomContent();
  });
  roomStream.addEventListener('left', () => { restoreCampaign(); if (currentModal === 'room') closeModal(); toast('Ты вышел из комнаты'); });
  roomStream.onerror = () => { if (!multiplayer) return; const connected = multiplayer.connected; multiplayer.connected = false; render(); if (currentModal === 'room') updateRoomContent(); if (connected) toast('Восстанавливаем соединение. На возвращение есть 90 секунд.'); };
}
async function leaveRoom() {
  if (!multiplayer) return true;
  try { await api(`rooms/${multiplayer.code}/leave`, { method: 'POST', body: '{}' }); restoreCampaign(); closeModal(); return true; }
  catch (e) { if (e.status === 404 || e.status === 401) { restoreCampaign(); closeModal(); return true; } toast(e.message); return false; }
}
function roomContent() {
  const r = multiplayer; if (!r) return '';
  return `<h2 class="modal-title">${r.state === 'lobby' ? 'Друзья против друзей.' : 'Твоя онлайн-битва.'}</h2><p class="modal-description">${MAPS[r.map - 1].name} · 2–4 игрока<br>${r.connected ? 'Соединение с сервером установлено.' : 'Восстанавливаем соединение…'}</p><div class="room-code"><span>КОД КОМНАТЫ</span><strong>${r.code}</strong><button class="text-button" data-action="mp-copy">Копировать</button></div><div class="room-players">${r.players.map(p => `<div class="room-player"><i style="background:${COLORS[p.owner]}"></i><strong>${escape(p.name)}${p.id === user.id ? ' · ты' : ''}</strong><span>${p.left ? 'Вышел' : p.connected ? 'На связи' : 'Подключается'}${p.id === r.host ? ' · создатель' : ''}</span></div>`).join('')}</div><p class="form-error" id="roomError" role="alert"></p><div class="button-stack">${r.state === 'lobby' ? r.host === user.id ? `<button class="primary-button" data-action="mp-start" ${r.players.length < 2 || r.players.some(p => !p.connected) ? 'disabled' : ''}>Начать битву ${icon('arrow')}</button>` : '<p class="form-note">Битву начнёт создатель комнаты.</p>' : '<button class="primary-button" data-action="close">Вернуться на поле боя</button>'}<button class="secondary-button" data-action="mp-reconnect">Обновить соединение</button><button class="danger-button" data-action="mp-leave">${r.state === 'playing' ? 'Сдаться и выйти' : 'Выйти из комнаты'}</button></div><p class="form-note">В битве нет паузы. Если пропадёт связь, можно вернуться с любого устройства через этот аккаунт за 90 секунд. Кампания сохранена отдельно.</p>`;
}
function updateRoomContent() { if (multiplayer) { const html = roomContent(); if (html !== renderedRoomContent) { renderedRoomContent = html; $('modalBody').innerHTML = html; } } }
function openRoom() { if (multiplayer) { renderedRoomContent = roomContent(); openModal('room', renderedRoomContent, 'STATE.IO / МУЛЬТИПЛЕЕР'); } }
async function openMultiplayer() {
  if (multiplayer) return openRoom();
  if (!user || authUnknown) { toast('Для битвы с друзьями войди в аккаунт'); return openAuth(); }
  try { const data = await api('rooms'); if (data.room) return enterRoom(data.room); }
  catch (e) { return toast(e.message); }
  openModal('multiplayer', `<h2 class="modal-title">Твоя стратегия. Живой соперник.</h2><p class="modal-description">Создай комнату и отправь код друзьям. До четырёх командиров на одной карте, без ботов.</p><form id="createRoomForm"><label class="form-field">Поле боя<select name="map">${MAPS.map((m,i) => `<option value="${i+1}">${m.name}</option>`).join('')}</select></label><button type="submit" class="primary-button full-width">Создать комнату ${icon('arrow')}</button></form><div class="room-or">или присоединись к друзьям</div><form id="joinRoomForm"><label class="form-field">Код комнаты<input name="code" minlength="6" maxlength="6" pattern="[A-Fa-f0-9]{6}" autocomplete="off" placeholder="Например, A1B2C3" required></label><button type="submit" class="secondary-button full-width">Присоединиться</button></form><p class="form-error" id="roomError" role="alert"></p>`, 'STATE.IO / МУЛЬТИПЛЕЕР');
}
function openResult() {
  const won = game.status === 'won';
  openModal('result', `<div class="result-hero">${icon(won ? 'cup' : 'restart')}</div><h2 class="modal-title">${won ? 'Эта карта — твоя.' : 'Битва окончена. Игра продолжается.'}</h2><p class="modal-description">${won ? game.level === TOTAL_LEVELS ? 'Все 24 операции позади. Твоя империя построена.' : 'Отличный ход. Следующая операция уже доступна.' : 'Попробуй другую стратегию: наращивай армию, захватывай свободные земли и защищай свою базу.'}</p><div class="result-stats"><div><strong>${formatTime(game.time)}</strong><span>Время битвы</span></div><div><strong>${String(game.level).padStart(2, '0')}</strong><span>Операция</span></div><div><strong>${profile.wins}</strong><span>Побед</span></div></div><div class="button-stack"><button class="primary-button" data-action="result-next">${won ? game.level === TOTAL_LEVELS ? 'Карта кампании' : 'Следующая операция' : 'Ещё одна попытка'} ${icon('arrow')}</button><button class="secondary-button" data-action="close">Посмотреть карту</button></div>`, won ? 'STATE.IO / ПОБЕДА' : 'STATE.IO / НОВЫЙ ШАНС');
}
function openConflict() {
  openModal('conflict', `<h2 class="modal-title">Две партии. Один аккаунт.</h2><p class="modal-description">На другом устройстве появилось новое сохранение. Текущая партия остаётся на этом устройстве, пока ты не выберешь версию.</p><div class="button-stack"><button class="primary-button" data-action="use-cloud">Загрузить партию из аккаунта ${icon('cloud')}</button><button class="secondary-button" data-action="use-local">Заменить облачную партию текущей</button></div><p class="form-note">Замена сохранения затронет все устройства этого аккаунта.</p>`, 'STATE.IO / СИНХРОНИЗАЦИЯ');
}
async function resolveCloud(useLocal) {
  const button = $('modalBody').querySelector(`[data-action="${useLocal ? 'use-local' : 'use-cloud'}"]`); if (button) button.disabled = true;
  try {
    const cloud = await api('save'); version = cloud.version; updatedAt = cloud.updatedAt;
    if (!useLocal && cloud.save) { loadSnapshot(cloud.save); dirty = false; revision++; }
    else markDirty();
    conflict = false; localSave(); closeModal();
    if (useLocal || !cloud.save) await saveCloud({ quiet: false });
    else toast('Партия из аккаунта загружена');
    syncLabel();
  } catch (e) { toast(e.message); if (button) button.disabled = false; }
}
async function logout(offline = false) {
  if (multiplayer && !await leaveRoom()) return;
  pauseGame();
  if (!offline && dirty) {
    const saved = await saveCloud({ quiet: false });
    if (!saved) {
      if (conflict) return openConflict();
      return openModal('logout-warning', '<h2 class="modal-title">Прогресс пока на устройстве.</h2><p class="modal-description">Синхронизация недоступна. Если выйти сейчас, последние изменения останутся в этом браузере и будут предложены после следующего входа.</p><div class="button-stack"><button class="primary-button" data-action="logout-anyway">Выйти с локальным сохранением</button><button class="secondary-button" data-action="close">Остаться в аккаунте</button></div>');
    }
  }
  try { await api('logout', { method: 'POST', body: '{}' }); }
  catch { toast('Не удалось завершить серверную сессию. Проверь соединение.'); return; }
  localSave(); user = null; version = 0; updatedAt = null; dirty = false; conflict = false; authUnknown = false; accountReady = false; syncError = false;
  profile = DEFAULT_PROFILE(); game = createGame(); if (!loadLocal()) { buildMap(); render(); }
  userUI(); syncLabel(); closeModal(); toast('Ты вышел из аккаунта');
}
document.addEventListener('click', e => {
  const view = e.target.closest('[data-view]')?.dataset.view;
  if (view) ({ game: () => { closeModal(); }, multiplayer: openMultiplayer, campaign: openCampaign, achievements: openAchievements, settings: openSettings, help: openHelp })[view]?.();
});
$('accountButton').addEventListener('click', openAccount); $('cloudButton').addEventListener('click', () => conflict ? openConflict() : openAccount());
$('modalBody').addEventListener('click', async e => {
  const levelButton = e.target.closest('[data-level]');
  if (levelButton && !levelButton.disabled) {
    const level = Number(levelButton.dataset.level);
    if (level === game.level) { closeModal(); return; }
    openModal('level-confirm', `<h2 class="modal-title">Операция ${String(level).padStart(2, '0')}.</h2><p class="modal-description">${titles[level - 1]}. Текущая партия будет заменена новой. Пройденные уровни сохранятся.</p><div class="button-stack"><button class="primary-button" data-action="change-level" data-target="${level}">Начать операцию ${icon('arrow')}</button><button class="secondary-button" data-action="campaign">Вернуться к кампании</button></div>`); return;
  }
  const button = e.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action.startsWith('mp-')) {
    if (action === 'mp-leave') await leaveRoom();
    if (action === 'mp-copy') { try { await navigator.clipboard.writeText(multiplayer.code); toast('Код комнаты скопирован'); } catch { toast(`Код комнаты: ${multiplayer.code}`); } }
    if (action === 'mp-reconnect') { try { const data = await api('rooms'); if (data.room) enterRoom(data.room); else { restoreCampaign(); await openMultiplayer(); } } catch (err) { toast(err.message); } }
    if (action === 'mp-start') { button.disabled = true; try { await api(`rooms/${multiplayer.code}/start`, { method: 'POST', body: '{}' }); } catch (err) { if ($('roomError')) $('roomError').textContent = err.message; button.disabled = false; } }
    return;
  }
  if (action === 'login-tab') openAuth('login');
  if (action === 'register-tab') openAuth('register');
  if (action === 'close') closeModal();
  if (action === 'campaign') openCampaign();
  if (action === 'restart') { closeModal(); newLevel(game.level, true); }
  if (action === 'change-level') { const level = Number(button.dataset.target); if (level <= profile.unlocked) { closeModal(); newLevel(level, true); } }
  if (action === 'result-next') { closeModal(); startGame(); }
  if (action === 'save-settings') {
    profile.settings.difficulty = $('difficultySetting').value; profile.settings.sound = $('soundSetting').checked; profile.settings.reducedMotion = $('motionSetting').checked;
    applySettings(); markDirty(); localSave(); closeModal(); void saveCloud(); toast('Настройки сохранены');
  }
  if (action === 'sync') { if (conflict) return openConflict(); button.disabled = true; await saveCloud({ quiet: false, force: true }); if (currentModal === 'account') openAccount(); }
  if (action === 'reload-cloud') openModal('reload-confirm', '<h2 class="modal-title">Загрузить облачную партию?</h2><p class="modal-description">Текущая партия будет заменена последним сохранением аккаунта.</p><div class="button-stack"><button class="primary-button" data-action="use-cloud">Загрузить сохранение</button><button class="secondary-button" data-action="close">Отмена</button></div>');
  if (action === 'use-cloud') { if (saving) await saving; await resolveCloud(false); }
  if (action === 'use-local') {
    openModal('conflict-confirm', '<h2 class="modal-title">Заменить облачную партию?</h2><p class="modal-description">Сохранение с другого устройства будет заменено текущей партией. Продолжить?</p><div class="button-stack"><button class="primary-button" data-action="confirm-local">Заменить сохранение</button><button class="secondary-button" data-action="conflict">Назад</button></div>');
  }
  if (action === 'confirm-local') { if (saving) await saving; await resolveCloud(true); }
  if (action === 'conflict') openConflict();
  if (action === 'logout') await logout();
  if (action === 'logout-anyway') await logout(true);
  if (action === 'transfer-guest') { markDirty(); closeModal(); await saveCloud({ quiet: false }); }
  if (action === 'fresh-account') { profile = DEFAULT_PROFILE(); game = createGame(); buildMap(); render(); markDirty(); closeModal(); await saveCloud({ quiet: false }); }
});
$('modalBody').addEventListener('submit', async e => {
  if (!['createRoomForm', 'joinRoomForm'].includes(e.target.id)) return;
  e.preventDefault(); const form = e.target, button = form.querySelector('button'); button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try { const data = await api(form.id === 'createRoomForm' ? 'rooms' : 'rooms/join', { method: 'POST', body: JSON.stringify(form.id === 'createRoomForm' ? { map: Number(values.map) } : values) }); enterRoom(data.room); }
  catch (err) { $('roomError').textContent = err.message; button.disabled = false; }
});
$('modalBody').addEventListener('submit', async e => {
  if (e.target.id !== 'authForm') return;
  e.preventDefault(); const form = e.target, button = form.querySelector('[type="submit"]'); button.disabled = true;
  $('authError').textContent = '';
  try {
    pauseGame(); const guestSave = snapshot();
    const input = Object.fromEntries(new FormData(form));
    const data = await api(form.dataset.mode === 'register' ? 'register' : 'login', { method: 'POST', body: JSON.stringify(input) });
    const previousId = user?.id; accountReady = false; user = data.user; authUnknown = false; userUI();
    const cloud = await api('save');
    const local = (() => { try { return JSON.parse(localStorage.getItem(localKey())); } catch { return null; } })();
    version = cloud.version; updatedAt = cloud.updatedAt; dirty = false; conflict = false; accountReady = true; syncError = false;
    if (cloud.save) {
      if (local?.save && local.dirty && JSON.stringify(local.save) !== JSON.stringify(cloud.save)) {
        loadSnapshot(local.save); markDirty();
        if (local.version !== cloud.version) { conflict = true; openConflict(); }
        else { closeModal(); await saveCloud({ quiet: false }); }
      }
      else { loadSnapshot(cloud.save); closeModal(); toast('С возвращением! Твоя партия загружена.'); }
    } else if (!previousId && (guestSave.game.time > 0 || guestSave.profile.wins > 0)) {
      openModal('transfer', '<h2 class="modal-title">Продолжим твою кампанию?</h2><p class="modal-description">У тебя есть гостевая партия. Перенеси её в аккаунт, чтобы продолжить на другом устройстве.</p><div class="button-stack"><button class="primary-button" data-action="transfer-guest">Перенести гостевой прогресс</button><button class="secondary-button" data-action="fresh-account">Начать новую кампанию</button></div>');
    } else { profile = DEFAULT_PROFILE(); game = createGame(); buildMap(); render(); markDirty(); closeModal(); await saveCloud(); toast('Аккаунт готов. Удачной битвы!'); }
    localSave(); syncLabel();
  } catch (e) { if ($('authError')) $('authError').textContent = e.message; else toast(e.message); button.disabled = false; }
});
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !$('modal').open && !e.target.closest('input,button,select,[data-node]')) { e.preventDefault(); if (game.status === 'playing') { pauseGame(); void saveCloud(); } else startGame(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { pauseGame(); localSave(); void saveCloud(); } });
window.addEventListener('pagehide', () => { pauseGame(); localSave(); });
window.addEventListener('beforeunload', e => { localSave(); if (user && dirty && game.time > 0) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('online', () => { authUnknown ? void initializeAccount() : void saveCloud(); });
window.addEventListener('offline', syncLabel);
matchMedia('(max-width:650px)').addEventListener('change', e => { portrait = e.matches; buildMap(); render(); });
setInterval(() => { localSave(); void saveCloud(); }, 15000);
function frame(now) {
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, .1) : 0; lastFrame = now;
  if (!multiplayer && game.status === 'playing' && !$('modal').open && !document.hidden) {
    step(game, dt); markDirty();
    if (now - lastRender > 60) { render(); lastRender = now; }
    if (['won', 'lost'].includes(game.status) && !resultShown) {
      recordResult(profile, game); resultShown = true; markDirty(); localSave(); void saveCloud(); if (game.status === 'won') sound('win'); openResult();
    }
  }
  animateFleets(now);
  requestAnimationFrame(frame);
}
try { const remembered = JSON.parse(localStorage.getItem('stateio.lastUser')); if (remembered && typeof remembered.id === 'string' && typeof remembered.name === 'string' && typeof remembered.email === 'string') { user = remembered; authUnknown = true; } } catch { /* Start as guest. */ }
buildMap(); if (!loadLocal()) render(); applySettings(); userUI();
void initializeAccount(); requestAnimationFrame(frame);
