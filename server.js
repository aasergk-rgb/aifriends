// ローカル開発用サーバー (npm start)。Vercel では api/*.js と public/ がそのまま使われる。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env 読み込み
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { chat, memory, tts, config } = await import('./lib/core.js');
const routes = {
  'POST /api/chat': chat,
  'POST /api/memory': memory,
  'POST /api/tts': tts,
  'GET /api/config': config,
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const publicDir = path.join(__dirname, 'public');

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(publicDir, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const PORT = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    res.writeHead(404); return res.end();
  }
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: 'half',
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => console.log(`🫶 AI Best Friend: http://localhost:${PORT}`));
