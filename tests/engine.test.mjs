import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createMultiplayerGame, dispatch, step, recordResult, DEFAULT_PROFILE, validateSave } from '../public/engine.js';

test('maps are deterministic across devices and every campaign level is valid', () => {
  for (let level = 1; level <= 24; level++) {
    const game = createGame(level);
    assert.deepEqual(game, createGame(level));
    const profile = DEFAULT_PROFILE(); profile.unlocked = level;
    assert.deepEqual(validateSave({ schema: 1, profile, game }).game, game);
    assert.equal(game.nodes.filter(n => n.owner === 0).length, 1);
  }
});
test('100% dispatch launches exactly four individual soldiers per 0.1 seconds and conquers', () => {
  const game = createGame(); game.status = 'playing';
  game.nodes[0].units = 100; game.nodes[1].units = 10;
  game.nodes.filter(n => n.owner > 0).forEach(n => { n.units = 0; n.growth = 0; });
  assert.equal(dispatch(game, [0, 0], 1), 100);
  assert.equal(game.nodes[0].units, 100); assert.equal(game.fleets.length, 0);
  step(game, .05); assert.equal(game.fleets.length, 0);
  step(game, .05); assert.equal(game.fleets.length, 4); assert.ok(game.fleets.every(f => f.units === 1));
  assert.equal(game.orders[0].remaining, 96);
  step(game, .05); assert.equal(game.fleets.length, 4);
  step(game, .05); assert.equal(game.fleets.length, 8);
  for (let i = 0; i < 60; i++) step(game, .1);
  assert.equal(game.nodes[1].owner, 0);
  assert.ok(game.nodes[1].units >= 90); assert.equal(game.orders.length, 0);
});

test('last wave is smaller; growth stays behind; capture cancels queued troops', () => {
  const game = createGame(); game.status = 'playing'; game.nodes[0].units = 9;
  dispatch(game, [0], 1); for (let i = 0; i < 6; i++) step(game, .05);
  assert.equal(game.fleets.length, 9); assert.equal(game.orders.length, 0); assert.ok(game.nodes[0].units < 1);
  game.nodes[0].units = 80; dispatch(game, [0], 2); step(game, .1);
  game.nodes[0].owner = 1; const before = game.fleets.length; step(game, .1);
  assert.equal(game.orders.length, 0); assert.equal(game.fleets.length, before);
});

test('retargeting replaces the queue without duplicating or discarding the garrison', () => {
  const game = createGame(); game.status = 'playing'; game.nodes[0].units = 40;
  dispatch(game, [0], 1); dispatch(game, [0], 2);
  assert.equal(game.nodes[0].units, 40); assert.equal(game.orders.length, 1); assert.equal(game.orders[0].to, 2);
  step(game, .1); assert.ok(game.fleets.every(f => f.to === 2));
});
test('reinforcements, combat and fleets remaining after a lost base', () => {
  const game = createGame(); game.status = 'playing';
  game.nodes[1].owner = 0; game.nodes[1].units = 20;
  game.nodes[0].units = 100;
  game.nodes.filter(n => n.owner > 0).forEach(n => { n.units = 0; n.growth = 0; });
  dispatch(game, [0], 1);
  for (let i = 0; i < 60; i++) step(game, .1);
  assert.ok(game.nodes[1].units > 120);
  game.nodes.forEach(n => n.owner = 1);
  game.fleets = [{ id: 20, from: 0, to: 1, owner: 0, units: 999, progress: 0, duration: 2 }];
  game.nextId = 21;
  step(game, .1); assert.equal(game.status, 'playing');
  for (let i = 0; i < 20; i++) step(game, .1);
  assert.equal(game.nodes[1].owner, 0);
});
test('paused game does not advance; result records only once and unlocks next level', () => {
  const game = createGame(), profile = DEFAULT_PROFILE(); game.status = 'paused';
  const before = structuredClone(game); step(game, .1); assert.deepEqual(game, before);
  game.status = 'playing'; game.nodes.forEach(n => n.owner = 0); step(game, .1);
  assert.equal(game.status, 'won');
  recordResult(profile, game); recordResult(profile, game);
  assert.equal(profile.wins, 1); assert.equal(profile.unlocked, 2); assert.equal(profile.best[1], 0);
});
test('resuming exact snapshot preserves fleet destinations and deterministic simulation', () => {
  const a = createGame(8, 'hard'), profile = DEFAULT_PROFILE(); profile.unlocked = 8;
  a.status = 'playing'; dispatch(a, [0], 1);
  for (let i = 0; i < 10; i++) step(a, .1);
  const b = validateSave(JSON.parse(JSON.stringify({ schema: 1, profile, game: a }))).game;
  for (let i = 0; i < 150; i++) { step(a, .1); step(b, .1); }
  assert.deepEqual(a, b);
});
test('rejects oversized or manipulated saves', () => {
  const base = { schema: 1, profile: DEFAULT_PROFILE(), game: createGame() };
  for (const mutate of [v => v.game.nodes[0].x++, v => v.game.nodes[0].units = -1, v => v.game.nodes[0].units = Infinity, v => v.game.level = 24, v => v.profile.unlocked = 25, v => v.profile.settings.difficulty = 'invalid', v => v.game.fleets = Array(8193).fill({}), v => v.game.orders = [{ from: 0, to: 1, owner: 0, remaining: -1, clock: 0 }], v => v.game.status = 'unknown']) {
    const save = structuredClone(base); mutate(save); assert.throws(() => validateSave(save));
  }
});

test('previous map geometry and in-flight armies remain loadable', () => {
  const game = createGame(1, 'normal', 1); delete game.orders;
  game.status = 'paused'; game.fleets = [{ id: 1, from: 0, to: 1, owner: 0, units: 22, progress: .4, duration: Math.hypot(game.nodes[1].x-game.nodes[0].x, game.nodes[1].y-game.nodes[0].y)/105 }]; game.nextId = 2;
  const restored = validateSave({ schema: 1, profile: DEFAULT_PROFILE(), game }).game;
  assert.deepEqual(restored.nodes, game.nodes); assert.deepEqual(restored.fleets, game.fleets); assert.deepEqual(restored.orders, []);
});

test('multiplayer is symmetric, has no AI, and determines a winner independently of owner zero', () => {
  for (let level = 1; level <= 6; level++) for (let players = 2; players <= 4; players++) {
    const game = createMultiplayerGame(level, players);
    const template = createGame(level), expectedRival = template.nodes.find(n => n.owner === 1);
    assert.equal(game.nodes.find(n => n.owner === 1).id, expectedRival.id);
    assert.deepEqual(game.nodes.filter(n => n.owner >= 0).map(n => n.units), Array(players).fill(55));
    for (let i = 0; i < 100; i++) step(game, .1);
    assert.equal(game.fleets.length, 0); assert.equal(game.orders.length, 0); assert.equal(game.status, 'playing');
    game.nodes.forEach(n => { n.owner = 1; }); step(game, .1);
    assert.equal(game.status, 'finished'); assert.equal(game.winner, 1);
    const profile = DEFAULT_PROFILE(); recordResult(profile, game); assert.equal(profile.wins, 0);
  }
});
test('AI simulations for all maps and difficulties produce valid bounded saves', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) for (let level = 1; level <= 24; level++) {
    const game = createGame(level, difficulty), profile = DEFAULT_PROFILE(); profile.unlocked = 24; game.status = 'playing';
    for (let i = 0; i < 1000 && game.status === 'playing'; i++) step(game, .1);
    assert.doesNotThrow(() => validateSave({ schema: 1, profile, game }));
    assert.ok(game.nodes.every(n => n.units >= 0 && n.units <= 999));
  }
});
