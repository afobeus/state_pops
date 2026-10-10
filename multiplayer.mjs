import { randomBytes } from 'node:crypto';
import { createMultiplayerGame, dispatch, step } from './public/engine.js';

// Authoritative matches: browsers submit intentions, never troop counts or results.
export function createRooms({ json, err, body, limit, currentUser, now = () => Date.now() }) {
  const rooms = new Map(), memberships = new Map();
  const publicRoom = room => ({ code: room.code, host: room.host, map: room.map, state: room.state, players: room.players.map(p => ({ id: p.id, name: p.name, owner: p.owner, connected: p.streams.size > 0, left: p.left })), game: room.game, expiresIn: 90 });
  function packet(room) {
    const view = publicRoom(room);
    // Compact troop tuples keep individual-soldier animation affordable on mobile data.
    if (view.game) view.game = { ...view.game, fleets: view.game.fleets.map(f => [f.id, f.from, f.to, f.owner, Math.round(f.progress * 10000) / 10000]) };
    return `event: state\ndata: ${JSON.stringify(view)}\n\n`;
  }
  function send(room, res, encoded = packet(room)) {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(encoded);
  }
  function publish(room) { const encoded = packet(room); for (const p of room.players) for (const res of p.streams.keys()) send(room, res, encoded); }
  function remove(room, player) {
    memberships.delete(player.id); player.left = true;
    if (room.game && room.state === 'playing') {
      room.game.nodes.filter(n => n.owner === player.owner).forEach(n => { n.owner = -1; });
      room.game.fleets = room.game.fleets.filter(f => f.owner !== player.owner);
      room.game.orders = room.game.orders.filter(o => o.owner !== player.owner);
      step(room.game, 0);
      if (room.game.status === 'finished') room.state = 'finished';
    }
    for (const res of player.streams.keys()) { if (!res.destroyed && !res.writableEnded) { res.write('event: left\ndata: {}\n\n'); res.end(); } }
    player.streams.clear();
    if (room.state === 'lobby') {
      room.players = room.players.filter(p => !p.left);
      room.players.forEach((p, i) => { p.owner = i; });
      if (room.host === player.id) room.host = room.players[0]?.id;
    }
    room.touched = now();
    if (!room.players.some(p => !p.left)) rooms.delete(room.code);
    else publish(room);
  }
  function playerFor(room, user) {
    const player = room?.players.find(p => p.id === user.id && !p.left);
    if (!player) throw err(404, 'Комната не найдена.');
    player.lastSeen = now(); return player;
  }
  async function handle(req, res, path, user) {
    if (!user) throw err(401, 'Войди в аккаунт, чтобы играть с друзьями.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw err(403, 'Запрос с другого сайта запрещён');
    if (req.method !== 'GET') limit(`room:${user.id}`, 600, 60000);
    if (path === '/api/rooms' && req.method === 'GET') {
      const room = rooms.get(memberships.get(user.id));
      return json(res, 200, { room: room ? publicRoom(room) : null });
    }
    if (path === '/api/rooms' && req.method === 'POST') {
      if (memberships.has(user.id)) throw err(409, 'Ты уже в комнате. Вернись в неё или выйди.');
      if (rooms.size >= 40) throw err(503, 'Все комнаты заняты. Попробуй немного позже.');
      const input = await body(req);
      // The body read yields; another device may have created a room meanwhile.
      if (memberships.has(user.id)) throw err(409, 'Ты уже в комнате. Вернись в неё или выйди.');
      if (rooms.size >= 40) throw err(503, 'Все комнаты заняты. Попробуй немного позже.');
      if (!Number.isInteger(input.map) || input.map < 1 || input.map > 6) throw err(400, 'Выбери карту.');
      let code; do { code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); } while (rooms.has(code));
      const room = { code, host: user.id, map: input.map, state: 'lobby', players: [], game: null, touched: now() };
      room.players.push({ id: user.id, name: user.name, owner: 0, lastSeen: now(), streams: new Map(), left: false });
      rooms.set(code, room); memberships.set(user.id, code);
      return json(res, 201, { room: publicRoom(room) });
    }
    if (path === '/api/rooms/join' && req.method === 'POST') {
      limit(`room-join:${user.id}`, 30, 60000);
      const input = await body(req), code = String(input.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw err(404, 'Такой комнаты нет. Проверь код.');
      if (memberships.get(user.id) === code) return json(res, 200, { room: publicRoom(room) });
      if (memberships.has(user.id)) throw err(409, 'Сначала выйди из текущей комнаты.');
      if (room.state !== 'lobby') throw err(409, 'Битва уже началась.');
      if (room.players.length >= 4) throw err(409, 'В комнате уже четыре игрока.');
      room.players.push({ id: user.id, name: user.name, owner: room.players.length, lastSeen: now(), streams: new Map(), left: false });
      memberships.set(user.id, code); room.touched = now(); publish(room);
      return json(res, 200, { room: publicRoom(room) });
    }
    const match = path.match(/^\/api\/rooms\/([A-F0-9]{6})\/(stream|start|dispatch|leave)$/);
    if (!match) throw err(404, 'Не найдено');
    const room = rooms.get(match[1]), player = playerFor(room, user), action = match[2];
    if (action === 'stream' && req.method === 'GET') {
      if (player.streams.size >= 2) throw err(429, 'Комната открыта на двух устройствах. Закрой одну вкладку.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      res.flushHeaders(); res.write('retry: 1500\n\n');
      player.streams.set(res, req); send(room, res); publish(room);
      res.on('error', () => res.destroy());
      res.on('close', () => { player.streams.delete(res); player.lastSeen = now(); publish(room); });
      return;
    }
    if (req.method !== 'POST') throw err(405, 'Метод не поддерживается');
    if (action === 'start') {
      if (room.host !== user.id) throw err(403, 'Битву начинает создатель комнаты.');
      if (room.state !== 'lobby' || room.players.length < 2) throw err(409, 'Для битвы нужны хотя бы два игрока.');
      if (room.players.some(p => !p.streams.size)) throw err(409, 'Подождите подключения всех игроков.');
      room.game = createMultiplayerGame(room.map, room.players.length); room.state = 'playing'; room.touched = now(); publish(room);
      return json(res, 200, { ok: true });
    }
    if (action === 'leave') { remove(room, player); return json(res, 200, { ok: true }); }
    if (room.state !== 'playing') throw err(409, 'Битва сейчас не идёт.');
    if (!player.streams.size) throw err(409, 'Восстанови соединение с комнатой.');
    const input = await body(req), game = room.game;
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > game.nodes.length || input.sources.some(id => !Number.isInteger(id) || game.nodes[id]?.owner !== player.owner) || !Number.isInteger(input.target) || !game.nodes[input.target]) throw err(403, 'Можно отправлять только свою армию.');
    const sent = dispatch(game, input.sources, input.target);
    return json(res, 200, { sent });
  }
  let previous = performance.now(), accumulator = 0, lastPublish = 0, lastAuth = 0;
  const timer = setInterval(() => {
    const time = performance.now(), stamp = now();
    accumulator += Math.min(.25, (time - previous) / 1000); previous = time;
    const ticks = Math.floor((accumulator + 1e-9) / .05); accumulator -= ticks * .05;
    for (const room of rooms.values()) {
      for (const p of [...room.players]) {
        if (p.left) continue;
        if (time - lastAuth >= 5000) for (const [res, req] of p.streams) if (currentUser(req)?.id !== p.id) res.end();
        if (p.streams.size) p.lastSeen = stamp;
        else if (stamp - p.lastSeen > (room.state === 'lobby' ? 300000 : 90000)) remove(room, p);
      }
      if (room.state === 'playing') {
        for (let i = 0; i < ticks; i++) step(room.game, .05);
        if (room.game.status === 'finished') { room.state = 'finished'; room.touched = stamp; publish(room); }
      }
      if (room.state === 'finished' && stamp - room.touched > 600000) { room.players.filter(p => !p.left).forEach(p => remove(room, p)); }
      else if (time - lastPublish >= 100 && room.state === 'playing') publish(room);
    }
    if (time - lastPublish >= 100) lastPublish = time;
    if (time - lastAuth >= 5000) lastAuth = time;
  }, 50).unref();
  // Separate heartbeats also refresh lobby connectivity without sending battle snapshots.
  const heartbeat = setInterval(() => { for (const room of rooms.values()) publish(room); }, 2000).unref();
  return { handle, close() { clearInterval(timer); clearInterval(heartbeat); for (const room of rooms.values()) for (const p of room.players) for (const res of p.streams.keys()) res.end(); } };
}
