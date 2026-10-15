const http = require('http');
const fs = require('fs');
const path = require('path');
const paypal = require('./paypal');
const agent = require('./agent');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Optional password gate so a public deploy can't be used by strangers.
// Browsers get a simple sign-in page (cookie); scripts can still use HTTP basic auth.
const crypto = require('crypto');
const authToken = () => crypto.createHash('sha256').update(`settle:${process.env.APP_PASSWORD}`).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function authed(req) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return true;
  const c = /(?:^|;\s*)settle_auth=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (c && same(c[1], authToken())) return true;
  const [, b64] = (req.headers.authorization || '').split(' ');
  const p = Buffer.from(b64 || '', 'base64').toString().split(':').slice(1).join(':');
  return same(p, pass);
}

const LOGIN_PAGE = (error) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Settle — sign in</title><style>
:root{--bg:#f5f6f8;--panel:#fff;--ink:#14161a;--muted:#646b78;--line:#e4e7ec;--brand:#0b5cff;--bad:#c0262d}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--panel:#171a20;--ink:#eceef2;--muted:#9aa1ad;--line:#272b33;--bad:#f07178}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px;font-size:14px}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);margin-bottom:12px}
button{width:100%;font:inherit;font-weight:600;padding:10px;border-radius:10px;border:0;background:var(--brand);color:#fff;cursor:pointer}
.err{color:var(--bad);font-size:13px;margin:-4px 0 12px}</style></head><body>
<form method="post" action="/login"><h1>Settle</h1><p>AI accounts-receivable agent on PayPal. Enter the demo password to continue.</p>
<input type="password" name="password" placeholder="Password" autofocus required>${error ? '<div class="err">Wrong password — try again.</div>' : ''}
<button>Sign in</button></form></body></html>`;

async function handleLogin(req, res) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 1e4) break; }
  const pass = new URLSearchParams(s).get('password') || '';
  if (process.env.APP_PASSWORD && same(pass, process.env.APP_PASSWORD)) {
    res.writeHead(303, { Location: '/', 'Set-Cookie': `settle_auth=${authToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
    return res.end();
  }
  await new Promise(r => setTimeout(r, 800)); // slow down guessing
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(LOGIN_PAGE(true));
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, bad) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
});

// Each browser gets its own conversation via a random session cookie.
function sessionOf(req, res) {
  const m = /(?:^|;\s*)settle_sid=([a-f0-9]{32})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const sid = require('crypto').randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `settle_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

const routes = {
  'GET /api/status': async () => ({ paypal: paypal.mode, ai: !!process.env.ANTHROPIC_API_KEY }),
  'GET /api/invoices': async (b, sid) => ({ invoices: await paypal.list(), pending: agent.pendingList(sid) }),
  'POST /api/chat': async (b, sid) => agent.chat(String(b.message || '').slice(0, 8000), { session: sid }),
  'POST /api/approve': async (b, sid) => ({ result: await agent.approve(b.actionId, sid) }),
  'POST /api/reject': async (b, sid) => { agent.reject(b.actionId, sid); return { ok: true }; },
  'POST /api/reset': async (b, sid) => { agent.reset(sid); return { ok: true }; },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/login') return handleLogin(req, res);
  if (!authed(req)) {
    if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Password required — reload the page to sign in.' });
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_PAGE(false));
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    const sid = sessionOf(req, res);
    try { send(res, 200, await handler(req.method === 'POST' ? await body(req) : {}, sid)); }
    catch (e) { console.error(e); send(res, 500, { error: e.message }); }
    return;
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Settle running on http://localhost:${PORT} (PayPal: ${paypal.mode}, AI: ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off'})`));
}
module.exports = server;
