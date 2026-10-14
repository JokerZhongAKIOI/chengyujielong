import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadDict } from './dict.js';
import { Hub } from './hub.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

if (!existsSync(join(here, '..', 'data', 'words.json'))) {
  console.error('未找到词典 data/words.json，请先运行: npm run build:dict');
  process.exit(1);
}
const dict = loadDict();
const hub = new Hub({ dict });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

wss.on('connection', (ws) => {
  let alive = true;
  ws.on('pong', () => (alive = true));
  const conn = {
    send(obj) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    },
    close() {
      ws.close(4000, 'replaced');
    },
  };
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return conn.send({ type: 'error', message: '消息格式错误' });
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      hub.handle(conn, msg);
    } catch (e) {
      console.error('handle error', e);
      conn.send({ type: 'error', message: '服务器出错，请重试' });
    }
  });
  ws.on('close', () => hub.detach(conn));
  ws.on('error', () => {});
  // 心跳：清理半开连接
  const timer = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 25_000);
  ws.on('close', () => clearInterval(timer));
});

server.listen(PORT, HOST, () => {
  console.log(`成语接龙已启动: http://localhost:${PORT}  (词典 ${dict.size} 条)`);
});
