// কল চ্যাট — ওয়েবসাইট + সিগন্যালিং সার্ভার (শুধু Node.js, কোনো প্যাকেজ লাগে না)
// চালাতে: node server.js   (বা: npm start)
//
// ঐচ্ছিক এনভায়রনমেন্ট ভ্যারিয়েবল (দূরের নেটওয়ার্কে কল ঠিকঠাক চালাতে TURN সার্ভার):
//   TURN_URL=turn:your.host:3478,turns:your.host:5349   TURN_USER=...   TURN_PASS=...
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const MAX_CLIENTS = 500;          // একসঙ্গে সর্বোচ্চ অনলাইন ইউজার
const MAX_PER_IP = 20;            // এক IP থেকে সর্বোচ্চ সংযোগ
const MAX_SIGNALS_PER_MIN = 600;  // এক ইউজারের মিনিটে সর্বোচ্চ সিগন্যাল
const MAX_BODY_BYTES = 120 * 1024;
const RECONNECT_GRACE_MS = 2500;  // সাময়িক ডিসকানেক্টে ইউজার লিস্ট স্থিতিশীল রাখা
const TYPES = new Set(['offer', 'answer', 'ice', 'hangup', 'reject', 'busy']);

// ইউজারনেম -> { res, token, ip, count, hb, dropTimer }
const clients = new Map();
const ipCount = new Map();

const cleanName = (s) =>
  String(s || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 24);

function iceConfig() {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean);
    if (urls.length) {
      iceServers.push({
        urls,
        username: process.env.TURN_USER || '',
        credential: process.env.TURN_PASS || '',
      });
    }
  }
  return {
    iceServers,
    iceCandidatePoolSize: 8,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };
}

const MANIFEST = JSON.stringify({
  name: 'কল চ্যাট',
  short_name: 'কল চ্যাট',
  description: 'ব্রাউজারে ভয়েস ও ভিডিও কল',
  lang: 'bn',
  start_url: '/app',
  scope: '/',
  display: 'standalone',
  background_color: '#0b141a',
  theme_color: '#0f766e',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0f766e"/><path d="M22 18c-2 0-4 2-4 5 0 13 14 27 27 27 3 0 5-2 5-4l-1-5-8-3-4 4c-4-2-8-6-10-10l4-4-3-8z" fill="#fff"/></svg>`;

const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app': 'app.html',
  '/app.html': 'app.html',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function safeWrite(res, text) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    const ok = res.write(text);
    if (typeof res.flush === 'function') res.flush();
    return ok;
  } catch {
    return false;
  }
}

function send(res, event, data) {
  return safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastUsers() {
  const list = [...clients.keys()];
  const payload = `event: users\ndata: ${JSON.stringify(list)}\n\n`;
  for (const c of clients.values()) {
    safeWrite(c.res, payload);
  }
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function releaseClientEntry(user, c, notify = true) {
  if (c.hb) {
    clearInterval(c.hb);
    c.hb = null;
  }
  if (c.dropTimer) {
    clearTimeout(c.dropTimer);
    c.dropTimer = null;
  }
  if (clients.get(user) === c) {
    clients.delete(user);
    const n = (ipCount.get(c.ip) || 1) - 1;
    if (n <= 0) ipCount.delete(c.ip);
    else ipCount.set(c.ip, n);
    if (notify) broadcastUsers();
  }
}

function scheduleDropClient(user, c) {
  if (clients.get(user) !== c) return;
  if (c.hb) {
    clearInterval(c.hb);
    c.hb = null;
  }
  if (c.dropTimer) clearTimeout(c.dropTimer);
  c.dropTimer = setTimeout(() => {
    releaseClientEntry(user, c, true);
  }, RECONNECT_GRACE_MS);
  c.dropTimer.unref?.();
}

// প্রতি মিনিটে সিগন্যাল গণনা শূন্য করি
setInterval(() => {
  for (const c of clients.values()) c.count = 0;
}, 60000).unref();

const server = http.createServer((req, res) => {
  res.on('error', () => {});
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    return res.end();
  }

  // ক্লায়েন্ট সংযোগ (Server-Sent Events)
  if (req.method === 'GET' && url.pathname === '/events') {
    const user = cleanName(url.searchParams.get('user'));
    if (!user) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('name required');
    }

    const existing = clients.get(user);
    if (existing) {
      // আগের সংযোগটি গ্রেস পিরিয়ডে থাকলে বা মৃত হলে পরিষ্কার করে নতুন সংযোগ নিই
      if (existing.dropTimer || existing.res.writableEnded || existing.res.destroyed) {
        releaseClientEntry(user, existing, false);
      } else {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('name taken');
      }
    }

    if (clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('server full');
    }

    const ip = clientIp(req);
    if ((ipCount.get(ip) || 0) >= MAX_PER_IP) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('too many connections');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const token = crypto.randomBytes(16).toString('hex');
    const c = { res, token, ip, count: 0, hb: null, dropTimer: null };
    clients.set(user, c);
    ipCount.set(ip, (ipCount.get(ip) || 0) + 1);

    send(res, 'hello', { user, token });
    broadcastUsers();

    c.hb = setInterval(() => {
      if (!safeWrite(res, ':hb\n\n')) {
        scheduleDropClient(user, c);
      }
    }, 12000);
    c.hb.unref?.();

    req.on('close', () => scheduleDropClient(user, c));
    return;
  }

  // সিগন্যাল পাঠানো (offer / answer / ice / hangup / reject / busy)
  if (req.method === 'POST' && url.pathname === '/signal') {
    const chunks = [];
    let totalBytes = 0;
    let tooBig = false;

    req.on('data', (chunk) => {
      if (tooBig) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooBig = true;
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('payload too large');
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      if (tooBig || res.writableEnded) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(raw);
        const { from, to, type, data, token } = parsed || {};

        if (typeof from !== 'string' || typeof to !== 'string' || !TYPES.has(type)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('bad request');
        }

        const sender = clients.get(from);
        if (
          !sender ||
          typeof token !== 'string' ||
          token.length !== sender.token.length ||
          !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sender.token))
        ) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('forbidden');
        }

        if (++sender.count > MAX_SIGNALS_PER_MIN) {
          res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('slow down');
        }

        const target = clients.get(to);
        if (!target || to === from) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('offline');
        }

        const ok = send(target.res, 'signal', { from, type, data });
        if (!ok) {
          scheduleDropClient(to, target);
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('offline');
        }

        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('bad request');
      }
    });

    req.on('error', () => {});
    return;
  }

  if (req.method === 'GET' && url.pathname === '/config') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify(iceConfig()));
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ ok: true, online: clients.size }));
  }

  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    return res.end(MANIFEST);
  }

  if (req.method === 'GET' && url.pathname === '/icon.svg') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end(ICON);
  }

  // পেজ: / = ল্যান্ডিং, /app = কলিং অ্যাপ
  if ((req.method === 'GET' || req.method === 'HEAD') && PAGES[url.pathname]) {
    const filePath = path.join(__dirname, PAGES[url.pathname]);
    fs.readFile(filePath, (err, buf) => {
      if (res.writableEnded) return;
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('page not found');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP,
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('পেজ পাওয়া যায়নি');
});

// Render/প্রক্সির টাইমআউটের চেয়ে বেশি রাখি, যাতে সংযোগ হঠাৎ কাটে না
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, () => console.log(`সার্ভার চালু: http://localhost:${PORT}`));

// একটি ভুলে যেন পুরো সার্ভার বন্ধ না হয়
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

// নতুন ভার্সন ডিপ্লয়ের সময় ভদ্রভাবে বন্ধ হই (ক্লায়েন্ট নিজে আবার সংযুক্ত হবে)
function shutdown() {
  for (const [user, c] of clients.entries()) {
    if (c.hb) clearInterval(c.hb);
    if (c.dropTimer) clearTimeout(c.dropTimer);
    try { c.res.end(); } catch {}
    clients.delete(user);
  }
  ipCount.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
