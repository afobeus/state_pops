// Shared deterministic simulation. Coordinates and travel time are independent of screen size.
export const TOTAL_LEVELS = 24;
export const COLORS = ['#4285ed', '#ef776c', '#e5bb53', '#af90d3'];
export const DEFAULT_PROFILE = () => ({ unlocked: 1, wins: 0, losses: 0, best: {}, settings: { difficulty: 'normal', sound: true, reducedMotion: false } });
export function random(seed) {
  let x = seed >>> 0;
  return () => { x += 0x6D2B79F5; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function legacyGame(level = 1, difficulty = 'normal') {
  const rng = random(level * 9721);
  const rows = level < 4 ? 3 : 4;
  const nodes = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < 4; col++) {
      const id = nodes.length;
      nodes.push({ id, x: 110 + col * 175 + (rng() - .5) * 38, y: 95 + row * (400 / (rows - 1)) + (rng() - .5) * 28, owner: -1, units: 10 + Math.floor(rng() * 13), growth: 1 + rng() * .35 });
    }
  }
  nodes[0].owner = 0; nodes[0].units = 45;
  nodes[nodes.length - 1].owner = 1; nodes[nodes.length - 1].units = 33 + Math.min(level, 16);
  nodes[3].owner = 2; nodes[3].units = 30 + level;
  if (level > 6) { nodes[nodes.length - 4].owner = 3; nodes[nodes.length - 4].units = 28 + level; }
  return { schema: 1, level, difficulty, nodes, fleets: [], time: 0, aiClock: 0, nextId: 1, status: 'ready', resultRecorded: false };
}
export const MAPS = [
  { name: 'Осколки океана', kind: 'islands', outline: [[35,70],[380,25],[730,75],[750,480],[400,560],[35,500]] },
  { name: 'Кольцо рассвета', kind: 'ring', outline: Array.from({ length: 18 }, (_, i) => [390 + 350 * Math.cos(i * Math.PI / 9), 295 + 255 * Math.sin(i * Math.PI / 9)]) },
  { name: 'Алмазный материк', kind: 'diamond', outline: [[390,25],[755,290],[390,565],[25,290]] },
  { name: 'Длинный берег', kind: 'coast', outline: [[45,165],[165,40],[610,35],[740,145],[705,405],[560,540],[185,545],[40,420]] },
  { name: 'Звёздные острова', kind: 'stars', outline: [[30,30],[750,30],[750,550],[30,550]] },
  { name: 'Земли севера', kind: 'continent', outline: [[70,35],[545,25],[725,110],[750,400],[575,545],[210,550],[30,375],[25,160]] }
];
export function mapInfo(game) { return MAPS[(game.level - 1) % MAPS.length]; }
export function createGame(level = 1, difficulty = 'normal', mapVersion = 2) {
  if (mapVersion === 1) return legacyGame(level, difficulty);
  const rng = random(level * 9721), type = (level - 1) % 6, count = 12 + Math.floor((level - 1) / 6) * 2;
  const nodes = [];
  for (let i = 0; i < count; i++) {
    let x, y;
    if (type === 1) {
      const outer = i < count - 4, total = outer ? count - 4 : 4;
      const angle = (outer ? i : i - count + 4) / total * Math.PI * 2;
      x = 390 + (outer ? 285 : 110) * Math.cos(angle); y = 295 + (outer ? 205 : 80) * Math.sin(angle);
    } else if (type === 2) {
      const row = Math.floor(i / 4), col = i % 4, rows = Math.ceil(count / 4);
      y = 130 + row * 330 / (rows - 1);
      const half = 290 * (1 - Math.abs(y - 295) / 270);
      x = 390 - half + col * half * 2 / 3;
    } else if (type === 4) {
      const angle = i * 2.399963229728653, radius = Math.sqrt((i + 1) / count);
      x = 390 + 310 * radius * Math.cos(angle); y = 295 + 225 * radius * Math.sin(angle);
    } else {
      const cols = type === 3 ? 5 : 4, rows = Math.ceil(count / cols), row = Math.floor(i / cols), col = i % cols;
      x = 110 + col * 550 / (cols - 1) + (row % 2 ? 18 : -12);
      y = 100 + row * 385 / (rows - 1) + (type === 3 ? Math.sin(col * 1.4) * 35 : 0);
    }
    nodes.push({ id: i, x: x + (rng() - .5) * 18, y: y + (rng() - .5) * 16, owner: -1, units: 8 + Math.floor(rng() * 17), growth: 1 + rng() * .4 });
  }
  nodes[0].owner = 0; nodes[0].units = 45;
  // Choose distant starting bases, avoiding an unfair adjacent spawn.
  const starts = [0];
  for (let owner = 1; owner < (level > 6 ? 4 : 3); owner++) {
    const candidates = nodes.filter(n => !starts.includes(n.id));
    candidates.sort((a, b) => Math.min(...starts.map(id => Math.hypot(b.x - nodes[id].x, b.y - nodes[id].y))) - Math.min(...starts.map(id => Math.hypot(a.x - nodes[id].x, a.y - nodes[id].y))));
    const n = candidates[0]; n.owner = owner; n.units = 33 + Math.min(level, 16); starts.push(n.id);
  }
  return { schema: 1, mapVersion: 2, level, difficulty, nodes, fleets: [], orders: [], time: 0, aiClock: 0, nextId: 1, status: 'ready', resultRecorded: false };
}
export function createMultiplayerGame(level, players) {
  const game = createGame(level);
  const bases = game.nodes.filter(n => n.owner >= 0).sort((a, b) => a.owner - b.owner);
  // Multiplayer maps always offer four equally strong starting positions.
  if (bases.length < 4) {
    const rest = game.nodes.filter(n => n.owner < 0).sort((a, b) => Math.min(...bases.map(n => Math.hypot(b.x - n.x, b.y - n.y))) - Math.min(...bases.map(n => Math.hypot(a.x - n.x, a.y - n.y))));
    bases.push(rest[0]);
  }
  game.nodes.forEach(n => { n.owner = -1; if (bases.includes(n)) n.units = 16; });
  bases.slice(0, players).forEach((n, owner) => { n.owner = owner; n.units = 55; n.growth = 1.25; });
  game.mode = 'multiplayer'; game.players = players; game.winner = null; game.status = 'playing';
  return game;
}
export function dispatch(game, sourceIds, targetId) {
  if (game.status !== 'playing') return 0;
  const target = game.nodes[targetId];
  if (!target) return 0;
  let sent = 0;
  for (const id of [...new Set(sourceIds)]) {
    const from = game.nodes[id];
    if (!from || from.id === target.id || from.owner < 0) continue;
    const units = Math.floor(from.units);
    if (units < 1) continue;
    game.orders ??= [];
    game.orders = game.orders.filter(o => o.from !== id);
    game.orders.push({ from: id, to: targetId, owner: from.owner, remaining: units, clock: 0 });
    sent += units;
  }
  return sent;
}
function ai(game) {
  const rng = random(Math.floor(game.time * 10) + game.level * 719);
  for (let owner = 1; owner <= 3; owner++) {
    const mine = game.nodes.filter(n => n.owner === owner && n.units > 16 && !game.orders?.some(o => o.from === n.id));
    if (!mine.length) continue;
    const source = mine.sort((a, b) => b.units - a.units)[0];
    const candidates = game.nodes.filter(n => n.owner !== owner).map(n => ({ n, score: Math.hypot(n.x - source.x, n.y - source.y) * .055 + n.units + (n.owner === 0 ? -4 : 0) + rng() * 8 })).sort((a, b) => a.score - b.score);
    const target = candidates[0]?.n;
    if (target && (source.units > target.units * 1.15 + 8 || source.units > 90)) dispatch(game, [source.id], target.id);
    else {
      const frontier = game.nodes.filter(n => n.owner === owner && n.id !== source.id && n.units < source.units / 2).sort((a, b) => a.units - b.units)[0];
      if (frontier && rng() > .55) dispatch(game, [source.id], frontier.id);
    }
  }
}
export function step(game, dt) {
  if (game.status !== 'playing') return;
  dt = Math.max(0, Math.min(dt, .1));
  game.time += dt;
  for (const n of game.nodes) if (n.owner >= 0) n.units = Math.min(999, n.units + n.growth * dt * (game.mode === 'multiplayer' ? 1 : n.owner > 0 ? { easy: .72, normal: 1, hard: 1.35 }[game.difficulty] : 1.15));
  const arrived = [];
  for (const fleet of game.fleets) {
    fleet.progress += dt / fleet.duration;
    if (fleet.progress >= 1) arrived.push(fleet);
  }
  game.fleets = game.fleets.filter(f => f.progress < 1);
  for (const f of arrived) {
    const target = game.nodes[f.to];
    if (target.owner === f.owner) target.units = Math.min(999, target.units + f.units);
    else if (f.units > target.units) { target.units = f.units - target.units; target.owner = f.owner; }
    else target.units -= f.units;
  }
  game.orders ??= [];
  for (const o of game.orders) {
    const from = game.nodes[o.from], to = game.nodes[o.to];
    if (from.owner !== o.owner) { o.remaining = 0; continue; }
    o.remaining = Math.min(o.remaining, Math.floor(from.units));
    o.clock += dt;
    if (o.clock + 1e-9 < .1) continue;
    o.clock = Math.max(0, o.clock - .1);
    const count = Math.min(4, o.remaining, 8192 - game.fleets.length);
    for (let i = 0; i < count; i++) game.fleets.push({ id: game.nextId++, from: o.from, to: o.to, owner: o.owner, units: 1, progress: 0, duration: Math.hypot(to.x - from.x, to.y - from.y) / 105 });
    from.units -= count; o.remaining -= count;
  }
  game.orders = game.orders.filter(o => o.remaining > 0);
  game.aiClock += dt;
  const cadence = { easy: 3.8, normal: 2.7, hard: 1.8 }[game.difficulty];
  if (game.mode !== 'multiplayer' && game.aiClock >= cadence) { game.aiClock = 0; ai(game); }
  const alive = owner => game.nodes.some(n => n.owner === owner) || game.fleets.some(f => f.owner === owner);
  if (game.mode === 'multiplayer') {
    const survivors = Array.from({ length: game.players }, (_, i) => i).filter(alive);
    if (survivors.length <= 1) { game.status = 'finished'; game.winner = survivors[0] ?? null; }
  } else if (!alive(0)) game.status = 'lost';
  else if (![1, 2, 3].some(alive)) game.status = 'won';
}
export function recordResult(profile, game) {
  if (game.mode === 'multiplayer' || game.resultRecorded || !['won', 'lost'].includes(game.status)) return;
  game.resultRecorded = true;
  if (game.status === 'won') {
    profile.wins++;
    profile.unlocked = Math.min(TOTAL_LEVELS, Math.max(profile.unlocked, game.level + 1));
    profile.best[game.level] = Math.min(profile.best[game.level] ?? Infinity, Math.round(game.time));
  } else profile.losses++;
}
export function validateSave(value) {
  const fail = () => { throw new Error('Некорректное сохранение'); };
  if (!value || value.schema !== 1 || !value.profile || !value.game) fail();
  const p = value.profile, g = value.game;
  const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const number = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
  if (!integer(p.unlocked, 1, TOTAL_LEVELS) || !integer(p.wins, 0, 1000000) || !integer(p.losses, 0, 1000000)) fail();
  if (!p.settings || !['easy', 'normal', 'hard'].includes(p.settings.difficulty) || typeof p.settings.sound !== 'boolean' || typeof p.settings.reducedMotion !== 'boolean') fail();
  if (!p.best || Array.isArray(p.best) || Object.keys(p.best).length > TOTAL_LEVELS) fail();
  for (const [key, time] of Object.entries(p.best)) if (key !== String(Number(key)) || !integer(Number(key), 1, TOTAL_LEVELS) || !integer(time, 0, 864000)) fail();
  if (g.schema !== 1 || !integer(g.level, 1, p.unlocked) || !['easy', 'normal', 'hard'].includes(g.difficulty) || !['ready', 'playing', 'paused', 'won', 'lost'].includes(g.status) || typeof g.resultRecorded !== 'boolean') fail();
  if (!number(g.time, 0, 864000) || !number(g.aiClock, 0, 10) || !integer(g.nextId, 1, 100000000)) fail();
  if (g.mode || (g.mapVersion !== undefined && g.mapVersion !== 2)) fail();
  const template = createGame(g.level, g.difficulty, g.mapVersion || 1);
  if (!Array.isArray(g.nodes) || g.nodes.length !== template.nodes.length || !Array.isArray(g.fleets) || g.fleets.length > 8192) fail();
  g.nodes.forEach((n, i) => {
    const original = template.nodes[i];
    if (!n || n.id !== i || n.x !== original.x || n.y !== original.y || n.growth !== original.growth || !integer(n.owner, -1, 3) || !number(n.units, 0, 999)) fail();
  });
  const ids = new Set();
  if (g.fleets.reduce((sum, f) => sum + (f?.units || 0), 0) > 8192) fail();
  for (const f of g.fleets) {
    if (!f || !integer(f.id, 1, g.nextId - 1) || ids.has(f.id) || !integer(f.from, 0, g.nodes.length - 1) || !integer(f.to, 0, g.nodes.length - 1) || f.from === f.to || !integer(f.owner, 0, 3) || !integer(f.units, 1, 999) || !number(f.progress, 0, 1)) fail();
    const a = g.nodes[f.from], b = g.nodes[f.to], duration = Math.hypot(a.x - b.x, a.y - b.y) / 105;
    if (f.duration !== duration) fail();
    ids.add(f.id);
  }
  const orders = g.orders ?? [];
  if (!Array.isArray(orders) || orders.length > g.nodes.length) fail();
  const sources = new Set();
  for (const o of orders) {
    if (!o || !integer(o.from, 0, g.nodes.length - 1) || !integer(o.to, 0, g.nodes.length - 1) || o.from === o.to || sources.has(o.from) || !integer(o.owner, 0, 3) || !integer(o.remaining, 1, 999) || !number(o.clock, 0, .1)) fail();
    sources.add(o.from);
  }
  // Only retain supported keys. Local campaign saves are client-authored, not a competitive ranking.
  return { schema: 1, profile: { unlocked: p.unlocked, wins: p.wins, losses: p.losses, best: { ...p.best }, settings: { difficulty: p.settings.difficulty, sound: p.settings.sound, reducedMotion: p.settings.reducedMotion } }, game: { schema: 1, ...(g.mapVersion ? { mapVersion: 2 } : {}), level: g.level, difficulty: g.difficulty, nodes: g.nodes.map(({ id, x, y, owner, units, growth }) => ({ id, x, y, owner, units, growth })), fleets: g.fleets.map(({ id, from, to, owner, units, progress, duration }) => ({ id, from, to, owner, units, progress, duration })), orders: orders.map(({ from, to, owner, remaining, clock }) => ({ from, to, owner, remaining, clock })), time: g.time, aiClock: g.aiClock, nextId: g.nextId, status: g.status, resultRecorded: g.resultRecorded } };
}
