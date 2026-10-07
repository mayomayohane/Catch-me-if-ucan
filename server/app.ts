import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameError, Room, type RoomOptions } from './room.ts';
import { MAX_PHOTO_BYTES, type ClientMessage, type PhotoUploadRequest, type ServerMessage } from '../src/shared/protocol.ts';

const ROOM_IDLE_TTL_MS = 3 * 60 * 60 * 1000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export interface AppOptions {
  port?: number;
  dataDir?: string;
  /** Directory of the built client to serve (production). */
  staticDir?: string;
  room?: RoomOptions;
  tickMs?: number;
}

interface Conn {
  ws: WebSocket;
  room?: Room;
  playerId?: string;
}

export function createApp(opts: AppOptions = {}) {
  const photoDir = resolve(opts.dataDir ?? 'data', 'photos');
  mkdirSync(photoDir, { recursive: true });
  const rooms = new Map<string, Room>();
  const conns = new Set<Conn>();

  const newCode = () => {
    for (;;) {
      const code = String(Math.floor(10000 + Math.random() * 90000));
      if (!rooms.has(code)) return code;
    }
  };

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const broadcast = (room: Room) => {
    const serverNow = Date.now();
    for (const c of conns) {
      if (c.room === room && c.playerId) send(c.ws, { type: 'state', room: room.view(c.playerId), serverNow });
    }
  };

  const detach = (c: Conn) => {
    const { room, playerId } = c;
    c.room = undefined;
    c.playerId = undefined;
    if (!room || !playerId) return;
    // Only mark offline if no other socket of the same player is still attached.
    if (![...conns].some((o) => o !== c && o.room === room && o.playerId === playerId)) room.disconnect(playerId);
    broadcast(room);
  };

  const onMessage = (c: Conn, msg: ClientMessage) => {
    switch (msg.type) {
      case 'ping':
        return send(c.ws, { type: 'pong', serverNow: Date.now() });
      case 'create': {
        detach(c);
        const room = new Room(newCode(), opts.room);
        rooms.set(room.code, room);
        c.playerId = room.join(msg.key, msg.name);
        c.room = room;
        return broadcast(room);
      }
      case 'join': {
        const room = rooms.get(String(msg.code ?? '').trim());
        if (!room) throw new GameError('ルームが見つかりません');
        if (c.room !== room) detach(c);
        c.playerId = room.join(msg.key, msg.name);
        c.room = room;
        return broadcast(room);
      }
      case 'leave': {
        const { room, playerId } = c;
        if (room && playerId) {
          room.leave(playerId);
          c.room = undefined;
          c.playerId = undefined;
          if (room.players.size === 0) rooms.delete(room.code);
          else broadcast(room);
        }
        return send(c.ws, { type: 'left' });
      }
      default: {
        if (!c.room || !c.playerId) throw new GameError('ルームに参加していません');
        c.room.handle(c.playerId, msg);
        return broadcast(c.room);
      }
    }
  };

  const readJson = (req: IncomingMessage, limit: number) =>
    new Promise<unknown>((res, rej) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          rej(new GameError('写真のサイズが大きすぎます'));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          res(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          rej(new GameError('不正なリクエストです'));
        }
      });
      req.on('error', rej);
    });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const serveFile = (res: ServerResponse, file: string, cache: string) => {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cache });
    createReadStream(file).pipe(res);
  };

  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();

  const handlePhoto = async (req: IncomingMessage, res: ServerResponse) => {
    const body = (await readJson(req, Math.ceil(MAX_PHOTO_BYTES * 1.4))) as PhotoUploadRequest;
    const room = rooms.get(String(body?.code));
    if (!room) throw new GameError('ルームが見つかりません');
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl ?? ''));
    if (!m) throw new GameError('JPEG画像を送信してください');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_PHOTO_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) throw new GameError('不正な画像です');
    const fileName = `${room.code}-${randomUUID()}.jpg`;
    // Validate the mission before writing so rejected uploads leave nothing on disk.
    const photo = room.addPhoto(String(body.key), Number(body.mission), `/photos/${fileName}`, body.pos ?? null);
    await writeFile(join(photoDir, fileName), buf);
    broadcast(room);
    json(res, 200, { photo });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/photo') {
      handlePhoto(req, res).catch((err) => {
        json(res, err instanceof GameError ? 400 : 500, { error: err instanceof GameError ? err.message : 'サーバーエラー' });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
      const name = url.pathname.slice('/photos/'.length);
      const file = join(photoDir, name);
      if (/^[\w-]+\.jpg$/.test(name) && isFile(file)) return serveFile(res, file, 'private, max-age=86400');
    }
    if (req.method === 'GET' && opts.staticDir) {
      const root = resolve(opts.staticDir);
      const file = normalize(join(root, decodeURIComponent(url.pathname)));
      if (file.startsWith(root) && isFile(file)) return serveFile(res, file, 'public, max-age=3600');
      const index = join(root, 'index.html');
      if (isFile(index)) return serveFile(res, index, 'no-cache');
    }
    json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', (ws) => {
    const c: Conn = { ws };
    conns.add(c);
    ws.on('message', (data) => {
      try {
        onMessage(c, JSON.parse(String(data)) as ClientMessage);
      } catch (err) {
        send(ws, { type: 'error', message: err instanceof GameError ? err.message : '処理に失敗しました' });
        if (!(err instanceof GameError)) console.error(err);
      }
    });
    ws.on('close', () => {
      conns.delete(c);
      detach(c);
    });
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.tick()) broadcast(room);
      if (room.isEmpty && now - room.lastActivity > ROOM_IDLE_TTL_MS) rooms.delete(room.code);
    }
  }, opts.tickMs ?? 1000);

  return {
    server,
    rooms,
    listen: (port = opts.port ?? 8787) =>
      new Promise<number>((res) => server.listen(port, () => res((server.address() as { port: number }).port))),
    close: () =>
      new Promise<void>((res) => {
        clearInterval(timer);
        for (const c of conns) c.ws.terminate();
        wss.close();
        server.close(() => res());
      }),
  };
}
