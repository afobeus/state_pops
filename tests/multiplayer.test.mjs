import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRooms } from '../multiplayer.mjs';

class Response extends EventEmitter {
  writableLength = 0; destroyed = false; messages = [];
  writeHead() {} flushHeaders() {}
  write(text) { this.messages.push(text); }
  end() { this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function fixture() {
  let time = 0;
  const manager = createRooms({ now: () => time, json: (res, status, data) => { res.status = status; res.data = data; }, err: (status, message) => Object.assign(new Error(message), { status }), limit: () => {}, body: async req => req.input, currentUser: req => req.user });
  const people = Array.from({ length: 5 }, (_, i) => ({ id: `person-${i}`, name: `Player ${i}` }));
  async function request(path, who = 0, method = 'POST', input = {}) {
    const res = new Response(); await manager.handle({ headers: {}, method, input, user: people[who] }, res, `/api/rooms${path}`, people[who]); return res;
  }
  return { manager, request, advance(ms) { time += ms; }, people };
}
test('simultaneous creation from two devices produces only one room per account', async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([f.request('', 0, 'POST', { map: 1 }), f.request('', 0, 'POST', { map: 2 })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  } finally { f.manager.close(); }
});
test('four-seat lobby capacity, host transfer, start permissions, and late joins', async () => {
  const f = fixture(); const streams = [];
  try {
    const code = (await f.request('', 0, 'POST', { map: 2 })).data.room.code;
    for (let i = 1; i <= 3; i++) await f.request('/join', i, 'POST', { code });
    await assert.rejects(f.request('/join', 4, 'POST', { code }), e => e.status === 409);
    await f.request(`/${code}/leave`, 0);
    let room = (await f.request('', 1, 'GET')).data.room; assert.equal(room.host, f.people[1].id);
    assert.deepEqual(room.players.map(p => p.owner), [0,1,2]);
    for (let i = 1; i <= 3; i++) streams.push(await f.request(`/${code}/stream`, i, 'GET'));
    await assert.rejects(f.request(`/${code}/start`, 2), e => e.status === 403);
    await f.request(`/${code}/start`, 1);
    await assert.rejects(f.request('/join', 4, 'POST', { code }), e => e.status === 409);
    room = (await f.request('', 1, 'GET')).data.room;
    assert.equal(room.game.players, 3); assert.equal(room.state, 'playing');
    assert.equal(room.game.nodes.filter(n => n.owner >= 0).length, 3);
  } finally { streams.forEach(s => s.end()); f.manager.close(); }
});
test('disconnected players can reconnect within the grace period; later disconnect forfeits', async () => {
  const f = fixture();
  try {
    const code = (await f.request('', 0, 'POST', { map: 1 })).data.room.code;
    await f.request('/join', 1, 'POST', { code });
    const a = await f.request(`/${code}/stream`, 0, 'GET');
    const b = await f.request(`/${code}/stream`, 1, 'GET');
    await f.request(`/${code}/start`, 0); b.end(); f.advance(80000);
    await new Promise(r => setTimeout(r, 70));
    assert.equal((await f.request('', 1, 'GET')).data.room.state, 'playing');
    const resumed = await f.request(`/${code}/stream`, 1, 'GET');
    assert.match(resumed.messages.join(''), /event: state/);
    resumed.end(); f.advance(90001); await new Promise(r => setTimeout(r, 70));
    const room = (await f.request('', 0, 'GET')).data.room;
    assert.equal(room.state, 'finished'); assert.equal(room.game.winner, 0);
    assert.equal(room.players[1].left, true);
    assert.equal((await f.request('', 1, 'GET')).data.room, null);
    a.end();
  } finally { f.manager.close(); }
});
