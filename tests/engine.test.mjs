import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, dispatch, step, recordResult, DEFAULT_PROFILE, validateSave } from '../public/engine.js';

test('maps are deterministic across devices and every campaign level is valid', () => {
  for (let level = 1; level <= 24; level++) {
    const game = createGame(level);
    assert.deepEqual(game, createGame(level));
    const profile = DEFAULT_PROFILE(); profile.unlocked = level;
    assert.deepEqual(validateSave({ schema: 1, profile, game }).game, game);
    assert.equal(game.nodes.filter(n => n.owner === 0).length, 1);
  }
});
test('dispatch consumes only selected fraction and conquers a weaker neutral garrison', () => {
  const game = createGame(); game.status = 'playing';
  game.nodes[0].units = 100; game.nodes[1].units = 10;
  assert.equal(dispatch(game, [0, 0], 1, .5), 50);
  assert.equal(game.nodes[0].units, 50);
  for (let i = 0; i < 20; i++) step(game, .1);
  assert.equal(game.nodes[1].owner, 0);
  assert.ok(game.nodes[1].units >= 40);
});
test('reinforcements, combat and fleets remaining after a lost base', () => {
  const game = createGame(); game.status = 'playing';
  game.nodes[1].owner = 0; game.nodes[1].units = 20;
  game.nodes[0].units = 100;
  dispatch(game, [0], 1, .5);
  for (let i = 0; i < 20; i++) step(game, .1);
  assert.ok(game.nodes[1].units > 70);
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
  a.status = 'playing'; dispatch(a, [0], 1, .8);
  for (let i = 0; i < 10; i++) step(a, .1);
  const b = validateSave(JSON.parse(JSON.stringify({ schema: 1, profile, game: a }))).game;
  for (let i = 0; i < 150; i++) { step(a, .1); step(b, .1); }
  assert.deepEqual(a, b);
});
test('rejects oversized or manipulated saves', () => {
  const base = { schema: 1, profile: DEFAULT_PROFILE(), game: createGame() };
  for (const mutate of [v => v.game.nodes[0].x++, v => v.game.nodes[0].units = -1, v => v.game.nodes[0].units = Infinity, v => v.game.level = 24, v => v.profile.unlocked = 25, v => v.profile.settings.difficulty = 'invalid', v => v.game.fleets = Array(241).fill({}), v => v.game.status = 'unknown']) {
    const save = structuredClone(base); mutate(save); assert.throws(() => validateSave(save));
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
