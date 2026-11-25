// কল চ্যাট — ওয়েবসাইট + সিগন্যালিং সার্ভার (শুধু Node.js, কোনো প্যাকেজ লাগে না)
// চালাতে: node server.js   (বা: npm start)
//
// ঐচ্ছিক এনভায়রনমেন্ট ভ্যারিয়েবল (দূরের নেটওয়ার্কে কল ঠিকঠাক চালাতে TURN সার্ভার):
//   TURN_URL=turn:your.host:3478,turns:your.host:5349   TURN_USER=...   TURN_PASS=...
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TYPES = new Set(['offer', 'answer', 'ice', 'hangup', 'reject', 'busy']);
const clients = new Map(); // ইউজারনেম -> SSE response

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);

function iceConfig() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return { iceServers };
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

const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/app': 'app.html', '/app.html': 'app.html' };

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastUsers() {
  const list = [...clients.keys()];
  for (const res of clients.values()) send(res, 'users', list);
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
};

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');

  // ক্লায়েন্ট সংযোগ (Server-Sent Events)
  if (req.method === 'GET' && url.pathname === '/events') {
    const user = cleanName(url.searchParams.get('user'));
    if (!user) { res.writeHead(400); return res.end('name required'); }
    if (clients.has(user)) { res.writeHead(409); return res.end('name taken'); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.set(user, res);
    send(res, 'hello', { user });
    broadcastUsers();
    const hb = setInterval(() => res.write(':hb\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb);
      if (clients.get(user) === res) {
        clients.delete(user);
        broadcastUsers();
      }
    });
    return;
  }

  // সিগন্যাল পাঠানো (offer / answer / ice / hangup / reject / busy)
  if (req.method === 'POST' && url.pathname === '/signal') {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 100000) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const { from, to, type, data } = JSON.parse(body);
        if (!TYPES.has(type)) { res.writeHead(400); return res.end('bad type'); }
        if (!clients.has(from)) { res.writeHead(403); return res.end(); }
        const target = clients.get(to);
        if (!target || to === from) { res.writeHead(404); return res.end('offline'); }
        send(target, 'signal', { from, type, data });
        res.writeHead(200); res.end('ok');
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(iceConfig()));
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, online: clients.size }));
  }

  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    return res.end(MANIFEST);
  }

  if (req.method === 'GET' && url.pathname === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    return res.end(ICON);
  }

  // পেজ: / = ল্যান্ডিং, /app = কলিং অ্যাপ
  if (req.method === 'GET' && PAGES[url.pathname]) {
    fs.readFile(path.join(__dirname, PAGES[url.pathname]), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('page not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('পেজ পাওয়া যায়নি');
});

server.listen(PORT, () => console.log(`সার্ভার চালু: http://localhost:${PORT}`));
