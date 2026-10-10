// Shared deterministic simulation. Coordinates and travel time are independent of screen size.
export const TOTAL_LEVELS = 1000;
export const TRAVEL_SPEED = 105 * 3.5;
export const SOLDIER_RADIUS = 4;
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
export function aiTuning(level, difficulty = 'normal') {
  const skill = Math.pow((Math.max(1, Math.min(TOTAL_LEVELS, level)) - 1) / (TOTAL_LEVELS - 1), .55);
  const pace = { easy: 1.25, normal: 1, hard: .8 }[difficulty];
  return {
    skill, cadence: (.16 + 6 * (1 - skill) ** 2) * pace,
    warmup: 12 * (1 - skill) ** 3, mistakeRate: .86 * (1 - skill) ** 3,
    growth: (.45 + .55 * skill + 24 * skill ** 8) / pace,
    startingUnits: Math.round(14 + 50 * skill + 935 * skill ** 6),
    label: level <= 10 ? 'Новичок' : level <= 100 ? 'Разведчик' : level <= 300 ? 'Тактик' : level <= 700 ? 'Стратег' : level < 1000 ? 'Полководец' : 'Непобедимый'
  };
}
export function createGame(level = 1, difficulty = 'normal', mapVersion = 3) {
  if (mapVersion === 1) return legacyGame(level, difficulty);
  const rng = random(level * 9721), type = (level - 1) % 6, count = 12 + Math.floor((mapVersion === 2 ? level - 1 : (level - 1) % 24) / 6) * 2;
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
  const tuning = aiTuning(level, difficulty);
  nodes[0].owner = 0; nodes[0].units = mapVersion === 2 ? 45 : Math.round(60 - 15 * tuning.skill);
  // Choose distant starting bases, avoiding an unfair adjacent spawn.
  const starts = [0];
  const factions = mapVersion === 2 ? level > 6 ? 4 : 3 : level <= 5 ? 2 : level <= 30 ? 3 : 4;
  for (let owner = 1; owner < factions; owner++) {
    const candidates = nodes.filter(n => !starts.includes(n.id));
    candidates.sort((a, b) => Math.min(...starts.map(id => Math.hypot(b.x - nodes[id].x, b.y - nodes[id].y))) - Math.min(...starts.map(id => Math.hypot(a.x - nodes[id].x, a.y - nodes[id].y))));
    const n = candidates[0]; n.owner = owner; n.units = mapVersion === 2 ? 33 + Math.min(level, 16) : tuning.startingUnits; starts.push(n.id);
  }
  return { schema: 1, mapVersion, level, difficulty, nodes, fleets: [], orders: [], time: 0, aiClock: 0, nextId: 1, status: 'ready', resultRecorded: false };
}
export function createMultiplayerGame(level, players) {
  const game = createGame(level);
  const bases = game.nodes.filter(n => n.owner >= 0).sort((a, b) => a.owner - b.owner);
  // Multiplayer maps always offer four equally strong starting positions.
  while (bases.length < 4) {
    const rest = game.nodes.filter(n => n.owner < 0).sort((a, b) => Math.min(...bases.map(n => Math.hypot(b.x - n.x, b.y - n.y))) - Math.min(...bases.map(n => Math.hypot(a.x - n.x, a.y - n.y))));
    bases.push(rest.find(n => !bases.includes(n)));
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
function ai(game, tuning) {
  const rng = random(Math.floor(game.time * 10) + game.level * 719);
  for (let owner = 1; owner <= 3; owner++) {
    const mine = game.nodes.filter(n => n.owner === owner && n.units >= 8 && !game.orders.some(o => o.from === n.id)).sort((a,b) => b.units-a.units);
    const sources = mine.slice(0, tuning.skill >= .85 ? mine.length : tuning.skill >= .55 ? 3 : 1);
    const arrivals = (id, friendly) => game.fleets.filter(f => f.to === id && (friendly ? f.owner === owner : f.owner !== owner)).reduce((s,f) => s+f.units,0);
    for (const source of sources) {
      if (game.orders.some(o => o.from === source.id)) continue;
      if (rng() > .35 + tuning.skill * .65) continue;
      if (rng() < tuning.mistakeRate) {
        // Beginners waste turns, reinforce safe bases, and underestimate strong defenders.
        const targets = game.nodes.filter(n => n.id !== source.id && (tuning.skill >= .12 || n.owner !== 0));
        const target = targets[Math.floor(rng()*targets.length)];
        if (target && rng() > .35) dispatch(game, [source.id], target.id);
        continue;
      }
      if (tuning.skill >= .35) {
        const incoming = game.fleets.filter(f => f.to === source.id && f.owner !== owner).sort((a,b) => a.duration*(1-a.progress)-b.duration*(1-b.progress));
        const attacker = incoming[0] && game.nodes[incoming[0].from];
        if (attacker && attacker.owner !== owner && arrivals(source.id, false) > source.units * .45) {
          dispatch(game, [source.id], attacker.id); continue; // Counterflow intercepts the attacking stream.
        }
        const threatened = game.nodes.filter(n => n.owner === owner && n.id !== source.id && arrivals(n.id,false) > n.units + arrivals(n.id,true)).sort((a,b) => arrivals(b.id,false)-arrivals(a.id,false))[0];
        if (threatened) { dispatch(game,[source.id],threatened.id); continue; }
      }
      const candidates = game.nodes.filter(n => n.owner !== owner).map(n => {
        const distance = Math.hypot(n.x-source.x,n.y-source.y);
        const growth = n.owner < 0 ? 0 : n.growth * (n.owner === 0 ? 1.15 : tuning.growth);
        const friendly = tuning.skill >= .18 ? arrivals(n.id,true) : 0;
        const defenders = tuning.skill >= .18 ? game.fleets.filter(f => f.to === n.id && f.owner === n.owner).reduce((s,f) => s+f.units,0) : 0;
        const committed = tuning.skill >= .55 ? game.orders.filter(o => o.owner === owner && o.to === n.id).reduce((s,o) => s+o.remaining,0) : 0;
        const forecast = n.units+defenders+growth*(distance/TRAVEL_SPEED+source.units/80)*tuning.skill;
        const defense = Math.max(0,forecast-friendly-committed);
        return { n, defense, covered: friendly+committed > forecast, score: defense + distance*.035 - n.growth*tuning.skill*6 - (n.owner===0 ? tuning.skill*28 : 0) + rng()*(1-tuning.skill)*18 };
      }).filter(c => !c.covered).sort((a,b) => a.score-b.score);
      const target = candidates.find(c => source.units > c.defense*(1.22-.17*tuning.skill)+3);
      if (target) dispatch(game,[source.id],target.n.id);
      else if (tuning.skill >= .55) {
        const weakest = candidates[0], reserve = mine.filter(n => !game.orders.some(o => o.from===n.id));
        if (weakest && reserve.length > 1 && reserve.reduce((s,n)=>s+n.units,0) > weakest.defense*1.1+5) dispatch(game,reserve.map(n=>n.id),weakest.n.id);
      }
    }
  }
}
// This path is shared by drawing and combat; viewport shape cannot change collisions.
export function fleetPosition(game, fleet, progress = fleet.progress, soldier = 0) {
  const a = game.nodes[fleet.from], b = game.nodes[fleet.to];
  const dx = b.x-a.x, dy = b.y-a.y, distance = Math.hypot(dx,dy);
  const t = Math.max(0,Math.min(1,progress-soldier*.004));
  const margin = Math.min(.3,26/distance), along = margin+t*(1-2*margin);
  const bend = Math.pow(Math.sin(Math.PI*t),.3)*(((fleet.id+soldier)%4-1.5)*10);
  return { x: a.x+dx*along-dy/distance*bend, y: a.y+dy*along+dx/distance*bend };
}
function airborneCombat(game, dt) {
  if (!dt || game.fleets.length < 2) return;
  const cells = new Map(), pairs = new Set(), hits = [], size = 48, radius = SOLDIER_RADIUS*2;
  const moves = game.fleets.map(f => {
    const start = fleetPosition(game,f), until = Math.min(1,(1-f.progress)*f.duration/dt);
    const end = fleetPosition(game,f,f.progress+dt*until/f.duration);
    return { f, start, until, vx: until > 0 ? (end.x-start.x)/until : 0, vy: until > 0 ? (end.y-start.y)/until : 0, end };
  });
  for (let i=0;i<moves.length;i++) {
    const a=moves[i];
    const left=Math.floor((Math.min(a.start.x,a.end.x)-radius)/size), right=Math.floor((Math.max(a.start.x,a.end.x)+radius)/size);
    const top=Math.floor((Math.min(a.start.y,a.end.y)-radius)/size), bottom=Math.floor((Math.max(a.start.y,a.end.y)+radius)/size);
    for (let x=left;x<=right;x++) for (let y=top;y<=bottom;y++) {
      const key=`${x},${y}`, bucket=cells.get(key) || [];
      for (const j of bucket) {
        const b=moves[j]; if (a.f.owner===b.f.owner) continue;
        const pair=`${j}:${i}`; if(pairs.has(pair)) continue; pairs.add(pair);
        const rx=a.start.x-b.start.x, ry=a.start.y-b.start.y, vx=a.vx-b.vx, vy=a.vy-b.vy;
        const c=rx*rx+ry*ry-radius*radius, speed=vx*vx+vy*vy, dot=rx*vx+ry*vy;
        let contact=0;
        if (c>0) {
          const discriminant=dot*dot-speed*c;
          if(speed<1e-12 || discriminant<0) continue;
          contact=(-dot-Math.sqrt(discriminant))/speed;
        }
        if(contact>=-1e-9 && contact<=Math.min(a.until,b.until)+1e-9) hits.push({ a:a.f,b:b.f,contact });
      }
      bucket.push(i); cells.set(key,bucket);
    }
  }
  // Resolve first contact first; each soldier dies at most once, even at a crossroads.
  hits.sort((a,b)=>a.contact-b.contact || a.a.id-b.a.id || a.b.id-b.b.id);
  for(const {a,b} of hits) { const killed=Math.min(a.units,b.units); a.units-=killed; b.units-=killed; }
  game.fleets=game.fleets.filter(f=>f.units>0);
}
export function step(game, dt) {
  if (game.status !== 'playing') return;
  dt = Math.max(0, Math.min(dt, .1));
  game.time += dt;
  const tuning = aiTuning(game.level,game.difficulty);
  for (const n of game.nodes) if (n.owner >= 0) n.units = Math.min(999, n.units + n.growth * dt * (game.mode === 'multiplayer' ? 1 : n.owner > 0 ? tuning.growth : 1.15));
  airborneCombat(game,dt);
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
    for (let i = 0; i < count; i++) game.fleets.push({ id: game.nextId++, from: o.from, to: o.to, owner: o.owner, units: 1, progress: 0, duration: Math.hypot(to.x - from.x, to.y - from.y) / TRAVEL_SPEED });
    from.units -= count; o.remaining -= count;
  }
  game.orders = game.orders.filter(o => o.remaining > 0);
  game.aiClock += dt;
  if (game.mode !== 'multiplayer' && game.aiClock >= tuning.cadence) { game.aiClock = 0; if(game.time >= tuning.warmup) ai(game,tuning); }
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
  if (g.mode || (g.mapVersion !== undefined && ![2,3].includes(g.mapVersion)) || (g.mapVersion !== 3 && g.level > 24)) fail();
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
    const a = g.nodes[f.from], b = g.nodes[f.to], distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (f.duration !== distance/TRAVEL_SPEED && f.duration !== distance/105) fail();
    ids.add(f.id);
  }
  const orders = g.orders ?? [];
  if (!Array.isArray(orders) || orders.length > g.nodes.length) fail();
  const sources = new Set();
  for (const o of orders) {
    if (!o || !integer(o.from, 0, g.nodes.length - 1) || !integer(o.to, 0, g.nodes.length - 1) || o.from === o.to || sources.has(o.from) || !integer(o.owner, 0, 3) || !integer(o.remaining, 1, 999) || !number(o.clock, 0, .1)) fail();
    sources.add(o.from);
  }
  let nextId = g.nextId;
  const fleets = g.fleets.flatMap(f => Array.from({length:f.units},(_,j) => ({ id:j ? nextId++ : f.id,from:f.from,to:f.to,owner:f.owner,units:1,progress:Math.max(0,f.progress-j*.004),duration:Math.hypot(g.nodes[f.to].x-g.nodes[f.from].x,g.nodes[f.to].y-g.nodes[f.from].y)/TRAVEL_SPEED })));
  if(nextId>100000000) fail();
  // Only retain supported keys. Local campaign saves are client-authored, not a competitive ranking.
  return { schema: 1, profile: { unlocked: p.unlocked, wins: p.wins, losses: p.losses, best: { ...p.best }, settings: { difficulty: p.settings.difficulty, sound: p.settings.sound, reducedMotion: p.settings.reducedMotion } }, game: { schema: 1, ...(g.mapVersion ? { mapVersion:g.mapVersion } : {}), level: g.level, difficulty: g.difficulty, nodes: g.nodes.map(({ id, x, y, owner, units, growth }) => ({ id, x, y, owner, units, growth })), fleets, orders: orders.map(({ from, to, owner, remaining, clock }) => ({ from, to, owner, remaining, clock })), time: g.time, aiClock: g.aiClock, nextId, status: g.status, resultRecorded: g.resultRecorded } };
}
