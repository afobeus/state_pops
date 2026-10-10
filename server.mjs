import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, pbkdf2, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSave } from './public/engine.js';
import { createRooms } from './multiplayer.mjs';

const derive = promisify(pbkdf2);
const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
const origin = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
if (production && !origin.startsWith('https://')) throw new Error('Production requires APP_ORIGIN=https://your-domain');
const dbPath = process.env.DB_PATH || resolve(root, 'data/game.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS saves (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
PRAGMA user_version=1;`);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/engine.js', ['engine.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']]
]);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
function cookie(res, token, maxAge = 60 * 60 * 24 * 30) {
  res.setHeader('Set-Cookie', `state_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${production ? '; Secure' : ''}`);
}
function currentUser(req) {
  const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('state_session='))?.slice(14);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const user = db.prepare('SELECT u.id,u.email,u.name FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(hashToken(token), Date.now());
  return user ? { ...user, token } : null;
}
function publicUser(user) { return { id: user.id, name: user.name, email: user.email }; }
function limit(key, max, windowMs) {
  const now = Date.now();
  const row = db.prepare('INSERT INTO rate_limits(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING count,reset_at').get(key, now + windowMs, now, now, now + windowMs);
  if (row.count > max) throw err(429, 'Слишком много попыток. Попробуйте позже.');
}
async function body(req, maximum = 100000) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw err(415, 'Ожидается JSON');
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximum) throw err(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw err(400, 'Некорректный JSON'); }
}
async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 600000, 32, 'sha256');
  return `600000:${salt}:${hash.toString('hex')}`;
}
async function verify(password, stored) {
  const [rounds, salt, encoded] = stored.split(':');
  const candidate = await derive(password, salt, Number(rounds), 32, 'sha256');
  return timingSafeEqual(candidate, Buffer.from(encoded, 'hex'));
}
const dummyPassword = await passwordHash(randomBytes(32).toString('hex'));
function createSession(res, user) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + 30 * 86400000);
  cookie(res, token);
}
const multiplayer = createRooms({ json, err, body, limit, currentUser });
async function api(req, res, path) {
  if (!['GET', 'POST', 'PUT'].includes(req.method)) throw err(405, 'Метод не поддерживается');
  if (req.method !== 'GET') {
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw err(403, 'Запрос с другого сайта запрещён');
  }
  if (path === '/api/health' && req.method === 'GET') {
    db.prepare('SELECT 1').get(); return json(res, 200, { ok: true });
  }
  const user = currentUser(req);
  if (path === '/api/rooms' || path.startsWith('/api/rooms/')) return multiplayer.handle(req, res, path, user);
  if (path === '/api/me' && req.method === 'GET') return json(res, 200, { user: user ? publicUser(user) : null });
  if (['/api/register', '/api/login'].includes(path) && req.method === 'POST') {
    // X-Real-IP is trusted only for the loopback reverse proxy configured by deploy.sh.
    const remote = req.socket.remoteAddress;
    const ip = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) ? String(req.headers['x-real-ip'] || remote) : remote;
    limit(`auth-ip:${ip}`, 30, 15 * 60000);
    const input = await body(req);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = input.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 10 || password.length > 128) throw err(400, 'Укажите email и пароль от 10 до 128 символов.');
    limit(`auth-email:${hashToken(email)}`, 15, 15 * 60000);
    if (path === '/api/register') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length < 2 || name.length > 24) throw err(400, 'Имя должно содержать от 2 до 24 символов.');
      const id = randomUUID(), hash = await passwordHash(password);
      try { db.prepare('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)').run(id, email, name, hash, Date.now()); }
      catch (e) { if (e.errcode === 2067 || e.code?.includes('SQLITE_CONSTRAINT')) throw err(409, 'Этот email уже используется. Войдите в аккаунт.'); throw e; }
      const created = { id, email, name }; createSession(res, created);
      return json(res, 201, { user: created });
    }
    const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const valid = await verify(password, existing?.password || dummyPassword);
    if (!existing || !valid) throw err(401, 'Неверный email или пароль.');
    createSession(res, existing); return json(res, 200, { user: publicUser(existing) });
  }
  if (path === '/api/logout' && req.method === 'POST') {
    if (user) db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(user.token));
    cookie(res, '', 0); return json(res, 200, { ok: true });
  }
  if (path === '/api/save') {
    if (!user) throw err(401, 'Войдите в аккаунт для синхронизации.');
    if (req.method === 'GET') {
      const save = db.prepare('SELECT * FROM saves WHERE user_id=?').get(user.id);
      return json(res, 200, { version: save?.version || 0, updatedAt: save?.updated_at || null, save: save ? JSON.parse(save.data) : null });
    }
    if (req.method === 'PUT') {
      limit(`save:${user.id}`, 120, 60000);
      const input = await body(req, 1500000);
      if (!Number.isInteger(input.version) || input.version < 0) throw err(400, 'Некорректная версия');
      let save; try { save = validateSave(input.save); } catch { throw err(400, 'Некорректное сохранение'); }
      const updatedAt = Date.now(), data = JSON.stringify(save);
      let result;
      if (input.version === 0) result = db.prepare('INSERT INTO saves(user_id,data,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO NOTHING').run(user.id, data, updatedAt);
      else result = db.prepare('UPDATE saves SET data=?,version=version+1,updated_at=? WHERE user_id=? AND version=?').run(data, updatedAt, user.id, input.version);
      if (!result.changes) {
        const cloud = db.prepare('SELECT version,updated_at FROM saves WHERE user_id=?').get(user.id);
        throw err(409, 'Партия сохранена на другом устройстве. Выберите, какую версию продолжить.', { version: cloud?.version || 0, updatedAt: cloud?.updated_at });
      }
      return json(res, 200, { version: input.version + 1, updatedAt });
    }
  }
  throw err(404, 'Не найдено');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const path = new URL(req.url, origin).pathname;
    if (path.startsWith('/api/')) return await api(req, res, path);
    if (!['GET', 'HEAD'].includes(req.method)) throw err(405, 'Метод не поддерживается');
    const asset = assets.get(path);
    if (!asset) throw err(404, 'Не найдено');
    const content = readFileSync(resolve(root, 'public', asset[0]));
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (e) {
    if (!e.status) console.error('Request failed:', e.message);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Ошибка сервера', ...e.extra });
    else res.end();
  }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
const cleanup = setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  db.prepare('DELETE FROM rate_limits WHERE reset_at<?').run(Date.now());
}, 60000).unref();
server.listen(PORT, HOST, () => console.log(`State.io: ${origin} (listening on ${HOST}:${PORT})`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(cleanup); multiplayer.close(); server.close(() => { db.close(); process.exit(0); }); });
