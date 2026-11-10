// Syrve Nomenclature Viewer — мінімальний сервер без залежностей (Node 18+).
// Проксіює запити до Syrve API, щоб обійти CORS і не світити токени у браузері.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const SYRVE_API = (process.env.SYRVE_API || 'https://api-eu.syrve.live/api/1').replace(/\/+$/, '');
// Токен v2 (/api/v2/access_token): apiKey + appId + clientSecret застосунку з Syrve Developer Portal
const SYRVE_API_V2 = SYRVE_API.replace(/\/api\/1$/, '/api/v2');
// Зовнішні меню: /api/2/menu і /api/2/menu/by_id
const SYRVE_API_2 = SYRVE_API.replace(/\/api\/1$/, '/api/2');
const TOKEN_TTL_MS = 50 * 60 * 1000; // токен Syrve живе ~60 хв, оновлюємо раніше
const REQUEST_TIMEOUT_MS = 180 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

// ключ авторизації (див. cacheKey) -> { token, exp }
const tokenCache = new Map();

class SyrveError extends Error {
  constructor(status, message, details, correlationId) {
    super(message);
    this.status = status;
    this.details = details;
    this.correlationId = correlationId;
  }
}

async function syrvePost(endpoint, body, token, base = SYRVE_API) {
  // body === undefined → запит без тіла (як /api/2/menu у Postman)
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(base + endpoint, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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

// v1: { v: 1, apiLogin }; v2: { v: 2, apiKey, appId, clientSecret }.
// appId / clientSecret для v2 можна не передавати, якщо вони задані у змінних середовища.
function readAuth(body) {
  if (Number(body.authVersion) === 2) {
    return {
      v: 2,
      apiKey: requireString(body.apiKey, 'apiKey'),
      appId: requireString(body.appId || process.env.SYRVE_APP_ID, 'appId'),
      clientSecret: requireString(body.clientSecret || process.env.SYRVE_CLIENT_SECRET, 'clientSecret'),
    };
  }
  return { v: 1, apiLogin: requireString(body.apiLogin, 'apiLogin') };
}

function cacheKey(auth) {
  return auth.v === 2 ? `v2:${auth.appId}:${auth.apiKey}:${auth.clientSecret}` : `v1:${auth.apiLogin}`;
}

async function getToken(auth, force = false) {
  const key = cacheKey(auth);
  const cached = tokenCache.get(key);
  if (!force && cached && cached.exp > Date.now()) return cached.token;

  const text = auth.v === 2
    ? await syrvePost('/access_token', { apiKey: auth.apiKey, appId: auth.appId, clientSecret: auth.clientSecret }, null, SYRVE_API_V2)
    : await syrvePost('/access_token', { apiLogin: auth.apiLogin });
  const token = JSON.parse(text).token;
  if (!token) throw new SyrveError(502, 'Syrve не повернув токен');
  tokenCache.set(key, { token, exp: Date.now() + TOKEN_TTL_MS });
  return token;
}

// Виконує запит з токеном; якщо токен прострочився (401) — оновлює і пробує ще раз.
async function withToken(auth, fn) {
  try {
    return await fn(await getToken(auth));
  } catch (err) {
    if (err instanceof SyrveError && err.status === 401) {
      tokenCache.delete(cacheKey(auth));
      return fn(await getToken(auth, true));
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
  // Що сторінка може показати у виборі застосунку v2. clientSecret назовні не віддається.
  'GET /api/config': async () => {
    const appId = (process.env.SYRVE_APP_ID || '').trim();
    const hasSecret = Boolean((process.env.SYRVE_CLIENT_SECRET || '').trim());
    return {
      v2App: appId && hasSecret ? { appId, name: (process.env.SYRVE_APP_NAME || '').trim() || 'Застосунок сервера' } : null,
    };
  },

  'POST /api/organizations': async (body) => {
    const auth = readAuth(body);
    return withToken(auth, (token) =>
      syrvePost('/organizations', {
        organizationIds: null,
        returnAdditionalInfo: body.returnAdditionalInfo === true,
        includeDisabled: body.includeDisabled !== false,
      }, token));
  },

  'POST /api/nomenclature': async (body) => {
    const auth = readAuth(body);
    const organizationId = requireString(body.organizationId, 'organizationId');
    const startRevision = Number.isFinite(body.startRevision) ? body.startRevision : 0;
    return withToken(auth, (token) =>
      syrvePost('/nomenclature', { organizationId, startRevision }, token));
  },

  // Список зовнішніх меню (externalMenus) і цінових категорій акаунта
  'POST /api/menus': async (body) => {
    const auth = readAuth(body);
    return withToken(auth, (token) => syrvePost('/menu', undefined, token, SYRVE_API_2));
  },

  // Вміст зовнішнього меню для організації
  'POST /api/menu': async (body) => {
    const auth = readAuth(body);
    const externalMenuId = requireString(String(body.externalMenuId ?? ''), 'externalMenuId');
    const organizationId = requireString(body.organizationId, 'organizationId');
    const version = Number.isInteger(body.version) ? body.version : 3;
    const payload = { externalMenuId, organizationIds: [organizationId], version };
    if (typeof body.priceCategoryId === 'string' && body.priceCategoryId.trim()) {
      payload.priceCategoryId = body.priceCategoryId.trim();
    }
    return withToken(auth, (token) => syrvePost('/menu/by_id', payload, token, SYRVE_API_2));
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
