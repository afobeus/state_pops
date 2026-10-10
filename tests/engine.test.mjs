import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createMultiplayerGame, dispatch, step, recordResult, DEFAULT_PROFILE, validateSave, TRAVEL_SPEED, TOTAL_LEVELS, fleetPosition, aiTuning } from '../public/engine.js';

test('maps are deterministic across devices and every campaign level is valid', () => {
  for (let level = 1; level <= TOTAL_LEVELS; level++) {
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
  game.nodes[0].owner = 1; const before = game.nextId; step(game, .1);
  assert.equal(game.orders.length, 0); assert.equal(game.nextId, before);
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
  for (const mutate of [v => v.game.nodes[0].x++, v => v.game.nodes[0].units = -1, v => v.game.nodes[0].units = Infinity, v => v.game.level = 24, v => v.profile.unlocked = 1001, v => v.profile.settings.difficulty = 'invalid', v => v.game.fleets = Array(8193).fill({}), v => v.game.orders = [{ from: 0, to: 1, owner: 0, remaining: -1, clock: 0 }], v => v.game.status = 'unknown']) {
    const save = structuredClone(base); mutate(save); assert.throws(() => validateSave(save));
  }
});

test('previous map geometry and in-flight armies remain loadable', () => {
  const game = createGame(1, 'normal', 1); delete game.orders;
  game.status = 'paused'; game.fleets = [{ id: 1, from: 0, to: 1, owner: 0, units: 22, progress: .4, duration: Math.hypot(game.nodes[1].x-game.nodes[0].x, game.nodes[1].y-game.nodes[0].y)/105 }]; game.nextId = 2;
  const restored = validateSave({ schema: 1, profile: DEFAULT_PROFILE(), game }).game;
  assert.deepEqual(restored.nodes, game.nodes); assert.deepEqual(restored.orders, []);
  assert.equal(restored.fleets.length, 22); assert.equal(restored.nextId, 23);
  assert.equal(new Set(restored.fleets.map(f => f.id)).size, 22);
  assert.ok(restored.fleets.every(f => f.units === 1 && Math.abs(f.duration - game.fleets[0].duration / 3.5) < 1e-12));
  assert.equal(restored.fleets[0].progress, .4);
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
  const levels = [...Array.from({length:24},(_,i) => i+1), 50, 100, 250, 500, 750, 999, 1000];
  for (const difficulty of ['easy', 'normal', 'hard']) for (const level of levels) {
    const game = createGame(level, difficulty), profile = DEFAULT_PROFILE(); profile.unlocked = TOTAL_LEVELS; game.status = 'playing';
    for (let i = 0; i < 1000 && game.status === 'playing'; i++) step(game, .1);
    assert.doesNotThrow(() => validateSave({ schema: 1, profile, game }));
    assert.ok(game.nodes.every(n => n.units >= 0 && n.units <= 999));
  }
});

function battlefield(coords = [[0,100],[300,100],[150,-50],[150,250]]) {
  return { ...createGame(), mode:'multiplayer', players:2, winner:null, status:'playing', nodes:coords.map(([x,y],id) => ({id,x,y,owner:id%2,units:10,growth:0})) };
}
function soldier(game,id,from,to,owner,progress=.42) {
  return {id,from,to,owner,progress,units:1,duration:Math.hypot(game.nodes[to].x-game.nodes[from].x,game.nodes[to].y-game.nodes[from].y)/TRAVEL_SPEED};
}
test('troops travel 3.5 times faster while launch cadence remains four per 100ms', () => {
  const game = battlefield(); dispatch(game,[0],1); step(game,.1);
  assert.equal(game.fleets.length,4); assert.equal(game.orders[0].remaining,6);
  assert.ok(game.fleets.every(f => f.duration === 300/(105*3.5)));
  const position = fleetPosition(game,game.fleets[0],.5);
  assert.equal(position.x,150);
});
test('fast opposing soldiers collide between frames and never arrive after dying', () => {
  const game = battlefield(); game.fleets=[soldier(game,1,0,1,0),soldier(game,2,1,0,1)];
  const old = game.fleets.map(f => fleetPosition(game,f));
  assert.ok(Math.hypot(old[0].x-old[1].x,old[0].y-old[1].y)>8);
  const next = game.fleets.map(f => fleetPosition(game,f,f.progress+.1/f.duration));
  assert.ok(Math.hypot(next[0].x-next[1].x,next[0].y-next[1].y)>8);
  step(game,.1); assert.equal(game.fleets.length,0);
  for(let i=0;i<15;i++) step(game,.1);
  assert.ok(game.nodes.every(n => n.units===10));
});
test('enemies collide at intersections of different routes; allies pass freely', () => {
  for(const sameTeam of [false,true]) {
    const game=battlefield(); game.fleets=[soldier(game,1,0,1,0),soldier(game,2,2,3,sameTeam?0:1)];
    step(game,.1); assert.equal(game.fleets.length,sameTeam?2:0);
  }
});
test('nearby parallel streams miss and casualties are exactly one for one', () => {
  const miss=battlefield([[0,100],[300,100],[300,140],[0,140]]);
  miss.fleets=[soldier(miss,1,0,1,0),soldier(miss,2,2,3,1)]; step(miss,.1); assert.equal(miss.fleets.length,2);
  const game=battlefield(); game.fleets=[soldier(game,1,0,1,0),soldier(game,5,0,1,0),soldier(game,2,1,0,1)];
  step(game,.1); assert.equal(game.fleets.length,1); assert.equal(game.fleets[0].owner,0); assert.equal(game.fleets[0].units,1);
});
test('old wave saves migrate without changing map, destinations or total soldiers', () => {
  const game=createGame(24,'hard',2), profile=DEFAULT_PROFILE(); profile.unlocked=24;
  game.status='playing'; dispatch(game,[0],1); step(game,.1);
  game.fleets.forEach(f => f.duration=Math.hypot(game.nodes[f.to].x-game.nodes[f.from].x,game.nodes[f.to].y-game.nodes[f.from].y)/105);
  const restored=validateSave({schema:1,profile,game}).game;
  assert.deepEqual(restored.nodes,game.nodes); assert.deepEqual(restored.orders,game.orders);
  assert.equal(restored.fleets.length,4); assert.ok(restored.fleets.every(f => f.to===1 && f.progress===0));
  assert.ok(restored.fleets.every(f => f.duration<game.fleets[0].duration/3));
});
test('first level is beatable with a single direct attack before the novice reacts', () => {
  for(const difficulty of ['easy','normal','hard']) {
    const game=createGame(1,difficulty); game.status='playing'; const rival=game.nodes.find(n => n.owner===1);
    dispatch(game,[0],rival.id);
    for(let i=0;i<100 && game.status==='playing';i++) step(game,.1);
    assert.equal(game.status,'won'); assert.ok(game.time<6);
    assert.ok(game.fleets.every(f => f.owner===0));
  }
});
test('AI becomes faster, less fallible and stronger throughout all 1000 levels', () => {
  for(const difficulty of ['easy','normal','hard']) {
    let previous=aiTuning(1,difficulty);
    for(let level=2;level<=1000;level++) {
      const next=aiTuning(level,difficulty);
      assert.ok(next.cadence<previous.cadence && next.mistakeRate<previous.mistakeRate && next.warmup<previous.warmup);
      assert.ok(next.growth>previous.growth && next.startingUnits>=previous.startingUnits); previous=next;
    }
    assert.equal(previous.mistakeRate,0); assert.equal(previous.startingUnits,999); assert.equal(previous.label,'Непобедимый');
  }
});
test('expert coordinates bases that cannot defeat a defender separately', () => {
  const game={...createGame(1000),status:'playing',time:1,aiClock:1,nodes:[{id:0,x:0,y:0,owner:1,units:16,growth:0},{id:1,x:0,y:100,owner:1,units:16,growth:0},{id:2,x:250,y:50,owner:0,units:21,growth:0}]};
  step(game,.1); assert.equal(game.orders.length,2);
  assert.ok(game.orders.every(o => o.to===2 && o.owner===1));
});
test('expert intercepts an incoming stream and takes empty territories', () => {
  const game={...createGame(1000),status:'playing',time:1,aiClock:1,nodes:[{id:0,x:0,y:0,owner:1,units:10,growth:0},{id:1,x:600,y:0,owner:0,units:80,growth:0}]};
  game.fleets=Array.from({length:8},(_,i) => soldier(game,i+1,1,0,0,.1)); game.nextId=9;
  step(game,.1); assert.equal(game.orders[0].from,0); assert.equal(game.orders[0].to,1);
  game.fleets=[]; game.orders=[]; game.nodes[1].units=0; game.aiClock=1;
  step(game,.1); assert.equal(game.orders[0].to,1);
});
test('1000th level defeats direct rush and expansion strategies even on easy', () => {
  for(const difficulty of ['easy','normal','hard']) for(const strategy of ['rush','expand']) {
    const game=createGame(1000,difficulty); game.status='playing';
    for(let tick=0;tick<1200 && game.status==='playing';tick++) {
      if(tick%5===0) for(const source of game.nodes.filter(n => n.owner===0 && n.units>=8 && !game.orders.some(o => o.from===n.id))) {
        const targets=game.nodes.filter(n => n.owner!==0);
        targets.sort((a,b) => strategy==='rush' ? (b.owner>0)-(a.owner>0) || a.units-b.units : a.units-b.units+Math.hypot(a.x-source.x,a.y-source.y)*.05-Math.hypot(b.x-source.x,b.y-source.y)*.05);
        if(targets[0]) dispatch(game,[source.id],targets[0].id);
      }
      step(game,.1);
    }
    assert.equal(game.status,'lost',`${difficulty}/${strategy}`);
  }
});
test('1000th operation and campaign progress remain synchronizable', () => {
  const profile=DEFAULT_PROFILE(); profile.unlocked=1000;
  const game=createGame(1000); game.status='playing'; game.nodes.forEach(n => n.owner=0); step(game,.1); recordResult(profile,game);
  assert.equal(profile.unlocked,1000); assert.equal(profile.wins,1); assert.equal(profile.best[1000],0);
  assert.deepEqual(validateSave({schema:1,profile,game}),{schema:1,profile,game});
});
