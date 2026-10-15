const http = require('http');
const fs = require('fs');
const path = require('path');
const paypal = require('./paypal');
const agent = require('./agent');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Optional basic-auth gate so a public deploy can't be used by strangers.
function authed(req) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return true;
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const [, p] = Buffer.from(b64 || '', 'base64').toString().split(':');
  return p === pass;
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
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Settle"' });
    return res.end('Password required');
  }
  const url = new URL(req.url, 'http://x');
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
