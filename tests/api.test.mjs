import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createGame, DEFAULT_PROFILE } from '../public/engine.js';

let child, folder, origin, dbPath, cookieA, cookieA2, cookieB;
const project = resolve(import.meta.dirname, '..');
const save = () => ({ schema: 1, profile: DEFAULT_PROFILE(), game: createGame() });
async function launch() {
  child = spawn(process.execPath, [resolve(project, 'server.mjs')], { cwd: project, env: { ...process.env, PORT: new URL(origin).port, HOST: '127.0.0.1', APP_ORIGIN: origin, DB_PATH: dbPath, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server failed to start')), 15000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('listening on')) { clearTimeout(timeout); resolveReady(); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
}
async function request(path, method = 'GET', payload, cookie, headers = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
before(async () => {
  folder = await mkdtemp(resolve(tmpdir(), 'state-io-test-')); dbPath = resolve(folder, 'test.sqlite');
  const port = await new Promise(resolvePort => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolvePort(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  await launch();
});
after(async () => {
  if (child && child.exitCode === null) { const exit = new Promise(r => child.once('exit', r)); child.kill(); await exit; }
  if (folder) await rm(folder, { recursive: true, force: true });
});
test('assets and security headers', async () => {
  const result = await request('/'); assert.equal(result.status, 200); assert.match(result.data, /Территория/);
  assert.equal(result.headers.get('x-frame-options'), 'DENY'); assert.match(result.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await request('/api/health')).data.ok, true);
  assert.equal((await request('/server.mjs')).status, 404);
  assert.equal((await request('/data/game.sqlite')).status, 404);
});
test('registration, duplicate email, HttpOnly cookie and password hashing', async () => {
  const credentials = { name: 'Командир', email: 'alpha@example.com', password: 'secret-password-123' };
  const a = await request('/api/register', 'POST', credentials);
  assert.equal(a.status, 201); assert.ok(a.cookie); cookieA = a.cookie;
  assert.match(a.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/); assert.equal(a.data.user.password, undefined);
  const duplicate = await request('/api/register', 'POST', credentials); assert.equal(duplicate.status, 409);
  const db = new DatabaseSync(dbPath); const row = db.prepare('SELECT password FROM users WHERE email=?').get(credentials.email);
  assert.notEqual(row.password, credentials.password); assert.match(row.password, /^600000:[a-f0-9]{32}:[a-f0-9]{64}$/); db.close();
});
test('login on a second device, bad passwords and isolated accounts', async () => {
  assert.equal((await request('/api/login', 'POST', { email: 'alpha@example.com', password: 'wrong-password-123' })).status, 401);
  const login = await request('/api/login', 'POST', { email: 'alpha@example.com', password: 'secret-password-123' }); assert.equal(login.status, 200); cookieA2 = login.cookie;
  const b = await request('/api/register', 'POST', { name: 'Другой', email: 'beta@example.com', password: 'another-password-123' }); cookieB = b.cookie; assert.equal(b.status, 201);
  assert.equal((await request('/api/me', 'GET', undefined, cookieA)).data.user.email, 'alpha@example.com');
  assert.equal((await request('/api/me', 'GET', undefined, cookieB)).data.user.email, 'beta@example.com');
  assert.equal((await request('/api/save')).status, 401);
});
test('saves travel between sessions, remain isolated and reject concurrent overwrites', async () => {
  const first = save(); first.game.status = 'paused'; first.game.time = 17;
  const stored = await request('/api/save', 'PUT', { version: 0, save: first }, cookieA); assert.equal(stored.status, 200); assert.equal(stored.data.version, 1);
  const secondDevice = await request('/api/save', 'GET', undefined, cookieA2); assert.deepEqual(secondDevice.data.save, first);
  assert.equal((await request('/api/save', 'GET', undefined, cookieB)).data.save, null);
  const parallel = await Promise.all([request('/api/save', 'PUT', { version: 1, save: first }, cookieA), request('/api/save', 'PUT', { version: 1, save: first }, cookieA2)]);
  assert.deepEqual(parallel.map(r => r.status).sort(), [200, 409]);
  assert.equal((await request('/api/save', 'GET', undefined, cookieA)).data.version, 2);
});
test('invalid payloads, foreign origins, missing origin and oversized requests rejected', async () => {
  const invalid = save(); invalid.game.nodes[0].x++;
  assert.equal((await request('/api/save', 'PUT', { version: 2, save: invalid }, cookieA)).status, 400);
  assert.equal((await request('/api/save', 'PUT', { version: 2, save: save() }, cookieA, { Origin: 'https://evil.example' })).status, 403);
  const missing = await fetch(`${origin}/api/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieA }, body: '{}' }); assert.equal(missing.status, 403);
  assert.equal((await request('/api/save', 'PUT', { version: 2, save: save(), padding: 'x'.repeat(101000) }, cookieA)).status, 413);
  const smallPassword = await request('/api/register', 'POST', { name: 'К', email: 'bad', password: 'x' }); assert.equal(smallPassword.status, 400);
});
test('logout revokes only this session while other device keeps its save', async () => {
  assert.equal((await request('/api/logout', 'POST', {}, cookieA)).status, 200);
  assert.equal((await request('/api/me', 'GET', undefined, cookieA)).data.user, null);
  assert.equal((await request('/api/save', 'GET', undefined, cookieA)).status, 401);
  assert.equal((await request('/api/save', 'GET', undefined, cookieA2)).data.version, 2);
});
test('SQLite accounts, sessions and snapshots survive a server restart', async () => {
  const exit = new Promise(r => child.once('exit', r)); child.kill(); await exit;
  await launch();
  assert.equal((await request('/api/me', 'GET', undefined, cookieA2)).data.user.email, 'alpha@example.com');
  const restored = await request('/api/save', 'GET', undefined, cookieA2);
  assert.equal(restored.data.version, 2); assert.equal(restored.data.save.game.time, 17);
});
test('persistent rate limits stop repeated password guesses', async () => {
  let result;
  for (let i = 0; i < 16; i++) result = await request('/api/login', 'POST', { email: 'alpha@example.com', password: 'wrong-password-123' });
  assert.equal(result.status, 429);
});
