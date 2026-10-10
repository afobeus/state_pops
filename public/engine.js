// Shared deterministic simulation. Coordinates and travel time are independent of screen size.
export const TOTAL_LEVELS = 24;
export const COLORS = ['#4285ed', '#ef776c', '#e5bb53', '#af90d3'];
export const DEFAULT_PROFILE = () => ({ unlocked: 1, wins: 0, losses: 0, best: {}, settings: { difficulty: 'normal', sound: true, reducedMotion: false } });
export function random(seed) {
  let x = seed >>> 0;
  return () => { x += 0x6D2B79F5; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function createGame(level = 1, difficulty = 'normal') {
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
export function dispatch(game, sourceIds, targetId, fraction = .5) {
  if (game.status !== 'playing') return 0;
  const target = game.nodes[targetId];
  if (!target) return 0;
  let sent = 0;
  for (const id of [...new Set(sourceIds)]) {
    const from = game.nodes[id];
    if (!from || from.id === target.id || from.owner < 0 || game.fleets.length >= 240) continue;
    const units = Math.floor(from.units * Math.max(.1, Math.min(1, fraction)));
    if (units < 1) continue;
    from.units -= units;
    const duration = Math.hypot(target.x - from.x, target.y - from.y) / 105;
    game.fleets.push({ id: game.nextId++, from: from.id, to: target.id, owner: from.owner, units, progress: 0, duration });
    sent += units;
  }
  return sent;
}
function ai(game) {
  const rng = random(Math.floor(game.time * 10) + game.level * 719);
  for (let owner = 1; owner <= 3; owner++) {
    const mine = game.nodes.filter(n => n.owner === owner && n.units > 16);
    if (!mine.length) continue;
    const source = mine.sort((a, b) => b.units - a.units)[0];
    const candidates = game.nodes.filter(n => n.owner !== owner).map(n => ({ n, score: Math.hypot(n.x - source.x, n.y - source.y) * .055 + n.units + (n.owner === 0 ? -4 : 0) + rng() * 8 })).sort((a, b) => a.score - b.score);
    const target = candidates[0]?.n;
    if (target && (source.units > target.units * 1.15 + 8 || source.units > 90)) dispatch(game, [source.id], target.id, .72);
    else {
      const frontier = game.nodes.filter(n => n.owner === owner && n.id !== source.id && n.units < source.units / 2).sort((a, b) => a.units - b.units)[0];
      if (frontier && rng() > .55) dispatch(game, [source.id], frontier.id, .4);
    }
  }
}
export function step(game, dt) {
  if (game.status !== 'playing') return;
  dt = Math.max(0, Math.min(dt, .1));
  game.time += dt;
  for (const n of game.nodes) if (n.owner >= 0) n.units = Math.min(999, n.units + n.growth * dt * (n.owner > 0 ? { easy: .72, normal: 1, hard: 1.35 }[game.difficulty] : 1.15));
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
  game.aiClock += dt;
  const cadence = { easy: 3.8, normal: 2.7, hard: 1.8 }[game.difficulty];
  if (game.aiClock >= cadence) { game.aiClock = 0; ai(game); }
  const alive = owner => game.nodes.some(n => n.owner === owner) || game.fleets.some(f => f.owner === owner);
  if (!alive(0)) game.status = 'lost';
  else if (![1, 2, 3].some(alive)) game.status = 'won';
}
export function recordResult(profile, game) {
  if (game.resultRecorded || !['won', 'lost'].includes(game.status)) return;
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
  const template = createGame(g.level, g.difficulty);
  if (!Array.isArray(g.nodes) || g.nodes.length !== template.nodes.length || !Array.isArray(g.fleets) || g.fleets.length > 240) fail();
  g.nodes.forEach((n, i) => {
    const original = template.nodes[i];
    if (!n || n.id !== i || n.x !== original.x || n.y !== original.y || n.growth !== original.growth || !integer(n.owner, -1, 3) || !number(n.units, 0, 999)) fail();
  });
  const ids = new Set();
  for (const f of g.fleets) {
    if (!f || !integer(f.id, 1, g.nextId - 1) || ids.has(f.id) || !integer(f.from, 0, g.nodes.length - 1) || !integer(f.to, 0, g.nodes.length - 1) || f.from === f.to || !integer(f.owner, 0, 3) || !integer(f.units, 1, 999) || !number(f.progress, 0, 1)) fail();
    const a = g.nodes[f.from], b = g.nodes[f.to], duration = Math.hypot(a.x - b.x, a.y - b.y) / 105;
    if (f.duration !== duration) fail();
    ids.add(f.id);
  }
  // Only retain supported keys. Local campaign saves are client-authored, not a competitive ranking.
  return { schema: 1, profile: { unlocked: p.unlocked, wins: p.wins, losses: p.losses, best: { ...p.best }, settings: { difficulty: p.settings.difficulty, sound: p.settings.sound, reducedMotion: p.settings.reducedMotion } }, game: { schema: 1, level: g.level, difficulty: g.difficulty, nodes: g.nodes.map(({ id, x, y, owner, units, growth }) => ({ id, x, y, owner, units, growth })), fleets: g.fleets.map(({ id, from, to, owner, units, progress, duration }) => ({ id, from, to, owner, units, progress, duration })), time: g.time, aiClock: g.aiClock, nextId: g.nextId, status: g.status, resultRecorded: g.resultRecorded } };
}
