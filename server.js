/**
 * 摊位倒计时 · 多人实时版 后端
 * - 零依赖：仅使用 Node.js 内置模块
 * - 数据存储：data/<房间号>.json（文件存储，无需数据库）
 * - 实时推送：SSE（Server-Sent Events）
 *
 * 启动：node server.js  （默认端口 3000，可用环境变量 PORT 覆盖）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_ID_RE = /^[A-Za-z0-9_-]{3,32}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });

/** 房间内存缓存：id -> { state, version, clients:Set, saveTimer } */
const rooms = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function isValidRoomId(id) { return ROOM_ID_RE.test(id); }
function roomFile(id) { return path.join(DATA_DIR, id + '.json'); }

function loadRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  const room = { state: [], version: 0, clients: new Set(), saveTimer: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(roomFile(id), 'utf8'));
    if (Array.isArray(parsed.state)) room.state = parsed.state;
    if (Number.isFinite(parsed.version)) room.version = parsed.version;
  } catch (e) { /* 新房间，无历史数据 */ }
  rooms.set(id, room);
  return room;
}

/** 防抖写盘：300ms 内的多次修改合并为一次写入（原子写，先写临时文件再重命名） */
function persistRoom(id, room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    const tmp = roomFile(id) + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: room.version, state: room.state }));
      fs.renameSync(tmp, roomFile(id));
    } catch (e) {
      console.error('[persist] 保存房间失败:', id, e.message);
    }
  }, 300);
}

function hms2sec(h, m, s) {
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

/** 服务端权威应用操作（单线程，天然原子性），并递增版本号 */
function applyOp(room, op) {
  const st = room.state;
  switch (op.type) {
    case 'init': // 全量覆盖（导入备份 / 清空重建）
      if (Array.isArray(op.state)) room.state = op.state;
      break;
    case 'addGroup':
      if (op.group && op.group.id != null) st.push(op.group);
      break;
    case 'deleteGroup': {
      const i = st.findIndex(g => String(g.id) === String(op.groupId));
      if (i > -1) st.splice(i, 1);
      if (st.length === 0) {
        st.push({ id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: '分组1', baseDate: '', baseH: 0, baseM: 0, baseS: 0, offset: 0, items: [] });
      }
      break;
    }
    case 'renameGroup': {
      const g = st.find(g => String(g.id) === String(op.groupId));
      if (g && typeof op.name === 'string') g.name = op.name.slice(0, 30);
      break;
    }
    case 'updateBase': { // 基准时间用 baseTs（UTC 毫秒时间戳）传递，避免服务器与客户端时区不一致
      const g = st.find(g => String(g.id) === String(op.groupId));
      if (!g) break;
      if (typeof op.baseDate === 'string') g.baseDate = op.baseDate;
      g.baseH = Number(op.baseH) || 0;
      g.baseM = Number(op.baseM) || 0;
      g.baseS = Number(op.baseS) || 0;
      g.offset = Number(op.offset) || 0;
      const baseTs = Number(op.baseTs) || 0;
      (g.items || []).forEach(it => {
        it.expireTs = baseTs + hms2sec(it.h, it.m, it.s) * 1000;
      });
      break;
    }
    case 'addItem': {
      const g = st.find(g => String(g.id) === String(op.groupId));
      if (g && op.item && op.item.name) g.items.push(op.item);
      break;
    }
    case 'deleteItem': {
      const g = st.find(g => String(g.id) === String(op.groupId));
      if (g) g.items = (g.items || []).filter(x => String(x.id) !== String(op.itemId));
      break;
    }
  }
  room.version++;
}

function broadcast(room, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of room.clients) {
    try { res.write(payload); } catch (e) { /* 客户端已断开 */ }
  }
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('bad url');
    return;
  }

  // ---------- API ----------
  const m = pathname.match(/^\/api\/room\/([^/]+)(\/.*)?$/);
  if (m) {
    const id = m[1];
    if (!isValidRoomId(id)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('房间号格式不合法'); return; }
    const rest = m[2] || '';
    const room = loadRoom(id);

    // 快照
    if (rest === '' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: room.version, state: room.state }));
      return;
    }
    // SSE 实时推送
    if (rest === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', version: room.version, state: room.state })}\n\n`);
      room.clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 25000);
      req.on('close', () => { clearInterval(ping); room.clients.delete(res); });
      return;
    }
    // 提交操作
    if (rest === '/op' && req.method === 'POST') {
      let body = '';
      let tooBig = false;
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) return;
        try {
          const op = JSON.parse(body);
          applyOp(room, op);
          persistRoom(id, room);
          broadcast(room, { type: 'op', version: room.version, op });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, version: room.version }));
        } catch (e) {
          res.writeHead(400).end('bad op');
        }
      });
      return;
    }
    // 解散房间：广播 destroyed → 断开所有人 → 删除内存与文件
    if (rest === '/destroy' && req.method === 'POST') {
      broadcast(room, { type: 'destroyed' });
      for (const res of room.clients) { try { res.end(); } catch (e) { /* ignore */ } }
      room.clients.clear();
      clearTimeout(room.saveTimer); // 取消未落盘的防抖写入，避免文件被"复活"
      rooms.delete(id);
      fs.rm(roomFile(id), { force: true }, () => {});
      console.log('[destroy] 房间已解散:', id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }

  // ---------- 静态文件 ----------
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

/** 自动清理长期未使用的房间（默认 30 天未写入即删除），启动时执行一次，之后每天一次 */
const STALE_MS = 30 * 24 * 3600 * 1000;
function cleanupStaleRooms() {
  fs.readdir(DATA_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(DATA_DIR, f);
      fs.stat(fp, (e, st) => {
        if (e) return;
        if (now - st.mtimeMs < STALE_MS) return;
        const id = f.slice(0, -5);
        if (!ROOM_ID_RE.test(id)) return;
        const room = rooms.get(id);
        if (room && room.clients.size > 0) return; // 仍有人在线，跳过
        fs.rm(fp, { force: true }, () => console.log('[cleanup] 已清理过期房间:', id));
      });
    }
  });
}
cleanupStaleRooms();
setInterval(cleanupStaleRooms, 24 * 3600 * 1000);

server.listen(PORT, () => {
  console.log(`摊位倒计时 · 多人实时版 已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
