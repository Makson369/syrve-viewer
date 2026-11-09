// Syrve Nomenclature Viewer — мінімальний сервер без залежностей (Node 18+).
// Проксіює запити до Syrve API, щоб обійти CORS і не світити токени у браузері.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const SYRVE_API = (process.env.SYRVE_API || 'https://api-eu.syrve.live/api/1').replace(/\/+$/, '');
const TOKEN_TTL_MS = 50 * 60 * 1000; // токен Syrve живе ~60 хв, оновлюємо раніше
const REQUEST_TIMEOUT_MS = 180 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

// apiLogin -> { token, exp }
const tokenCache = new Map();

class SyrveError extends Error {
  constructor(status, message, details, correlationId) {
    super(message);
    this.status = status;
    this.details = details;
    this.correlationId = correlationId;
  }
}

async function syrvePost(endpoint, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(SYRVE_API + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    throw new SyrveError(504, timedOut ? 'Syrve не відповів вчасно' : `Не вдалося з'єднатися з Syrve: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let message = `Syrve повернув помилку ${res.status}`;
    let correlationId;
    try {
      const j = JSON.parse(text);
      if (j.errorDescription) message = j.errorDescription;
      else if (j.error) message = j.error;
      correlationId = j.correlationId;
    } catch { /* тіло не JSON */ }
    throw new SyrveError(res.status, message, text.slice(0, 2000), correlationId);
  }
  return text;
}

async function getToken(apiLogin, force = false) {
  const cached = tokenCache.get(apiLogin);
  if (!force && cached && cached.exp > Date.now()) return cached.token;

  const text = await syrvePost('/access_token', { apiLogin });
  const token = JSON.parse(text).token;
  if (!token) throw new SyrveError(502, 'Syrve не повернув токен');
  tokenCache.set(apiLogin, { token, exp: Date.now() + TOKEN_TTL_MS });
  return token;
}

// Виконує запит з токеном; якщо токен прострочився (401) — оновлює і пробує ще раз.
async function withToken(apiLogin, fn) {
  try {
    return await fn(await getToken(apiLogin));
  } catch (err) {
    if (err instanceof SyrveError && err.status === 401) {
      tokenCache.delete(apiLogin);
      return fn(await getToken(apiLogin, true));
    }
    throw err;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SyrveError(413, 'Запит завеликий'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new SyrveError(400, 'Некоректний JSON у запиті'));
      }
    });
    req.on('error', reject);
  });
}

function send(req, res, status, body, contentType) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store' };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(req, res, status, obj) {
  send(req, res, status, typeof obj === 'string' ? obj : JSON.stringify(obj), 'application/json; charset=utf-8');
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new SyrveError(400, `Не вказано ${name}`);
  return value.trim();
}

const routes = {
  'POST /api/organizations': async (body) => {
    const apiLogin = requireString(body.apiLogin, 'apiLogin');
    return withToken(apiLogin, (token) =>
      syrvePost('/organizations', {
        organizationIds: null,
        returnAdditionalInfo: body.returnAdditionalInfo === true,
        includeDisabled: body.includeDisabled !== false,
      }, token));
  },

  'POST /api/nomenclature': async (body) => {
    const apiLogin = requireString(body.apiLogin, 'apiLogin');
    const organizationId = requireString(body.organizationId, 'organizationId');
    const startRevision = Number.isFinite(body.startRevision) ? body.startRevision : 0;
    return withToken(apiLogin, (token) =>
      syrvePost('/nomenclature', { organizationId, startRevision }, token));
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(req, res, 200, fs.readFileSync(INDEX_HTML), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(req, res, 200, { ok: true });
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return sendJson(req, res, 404, { error: 'Не знайдено' });

    const body = await readJsonBody(req);
    const result = await handler(body);
    return sendJson(req, res, 200, result); // віддаємо відповідь Syrve як є
  } catch (err) {
    const status = err instanceof SyrveError ? err.status : 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err.message);
    return sendJson(req, res, status, {
      error: err.message,
      status,
      correlationId: err.correlationId,
      details: err.details,
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Syrve viewer слухає на порту ${PORT} → ${SYRVE_API}`);
});
