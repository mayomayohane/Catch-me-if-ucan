import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.ts';
import type { ClientMessage, RoomView, ServerMessage } from '../src/shared/protocol.ts';

const CENTER = { lat: 35.681236, lng: 139.767125 };
// Smallest valid JPEG-looking payload (SOI marker + filler); the server only checks the header.
const FAKE_JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');

const dataDir = mkdtempSync(join(tmpdir(), 'cmiu-'));
const app = createApp({ dataDir, room: { photoIntervalMs: 300 }, tickMs: 50 });
let base = '';

before(async () => {
  const port = await app.listen(0);
  base = `127.0.0.1:${port}`;
});
after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

class Client {
  ws: WebSocket;
  last?: RoomView;
  errors: string[] = [];
  private waiters: Array<{ pred: (v: RoomView) => boolean; resolve: (v: RoomView) => void }> = [];

  constructor(public key: string) {
    this.ws = new WebSocket(`ws://${base}/ws`);
    this.ws.on('message', (d) => {
      const msg = JSON.parse(String(d)) as ServerMessage;
      if (msg.type === 'error') this.errors.push(msg.message);
      if (msg.type !== 'state') return;
      this.last = msg.room;
      this.waiters = this.waiters.filter((w) => (w.pred(msg.room) ? (w.resolve(msg.room), false) : true));
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }
  until(pred: (v: RoomView) => boolean, timeoutMs = 3000) {
    if (this.last && pred(this.last)) return Promise.resolve(this.last);
    return new Promise<RoomView>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for state')), timeoutMs);
      this.waiters.push({ pred, resolve: (v) => (clearTimeout(t), resolve(v)) });
    });
  }
}

test('a full 1 vs 4 game over WebSocket + HTTP photo upload', async () => {
  const clients = await Promise.all(
    ['host', 'p2', 'p3', 'p4', 'p5'].map(async (n) => {
      const c = new Client(`key-${n}-0123456789`);
      await c.open();
      return c;
    }),
  );
  const [host, ...guests] = clients;
  host.send({ type: 'create', key: host.key, name: 'ホスト' });
  const { code } = await host.until((v) => !!v.code);
  assert.match(code, /^\d{5}$/);

  for (const g of guests) g.send({ type: 'join', key: g.key, name: g.key.slice(4, 6), code });
  await host.until((v) => v.players.length === 5);

  host.send({ type: 'setSettings', teamMode: '1v4', center: CENTER, durationMin: 30 });
  host.send({ type: 'setRole', role: 'runner' });
  host.send({ type: 'setReady', ready: true });
  for (const g of guests) {
    g.send({ type: 'setRole', role: 'chaser' });
    g.send({ type: 'setReady', ready: true });
  }
  await host.until((v) => v.players.every((p) => p.ready));
  // A guest cannot start the game.
  guests[0].send({ type: 'start' });
  host.send({ type: 'start' });
  await Promise.all(clients.map((c) => c.until((v) => v.phase === 'playing')));
  assert.ok(guests[0].errors.some((e) => e.includes('ホスト')));

  // Runner leaves the area -> chasers see the runner with violation.
  host.send({ type: 'location', lat: CENTER.lat + 0.05, lng: CENTER.lng });
  const exposed = await guests[1].until((v) => v.players.some((p) => p.role === 'runner' && p.violation && !!p.pos));
  assert.ok(exposed);

  // First selfie mission fires (interval shortened to 300ms for the test).
  await host.until((v) => v.myPendingMissions.includes(1));
  const res = await fetch(`http://${base}/api/photo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, key: host.key, mission: 1, dataUrl: FAKE_JPEG, pos: CENTER }),
  });
  assert.equal(res.status, 200);
  const view = await guests[0].until((v) => v.photos.length === 1);
  const img = await fetch(`http://${base}${view.photos[0].url}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');

  // A chaser cannot submit a photo.
  const bad = await fetch(`http://${base}/api/photo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, key: guests[0].key, mission: 1, dataUrl: FAKE_JPEG, pos: null }),
  });
  assert.equal(bad.status, 400);

  // Capture flow.
  const runnerId = host.last!.meId;
  guests[2].send({ type: 'requestCapture', runnerId });
  const withReq = await host.until((v) => v.captureRequests.length > 0);
  host.send({ type: 'respondCapture', requestId: withReq.captureRequests[0].id, accept: true });
  const finished = await guests[3].until((v) => v.phase === 'finished');
  assert.equal(finished.result?.winner, 'chaser');
  assert.ok(finished.result?.tracks[runnerId].length);

  for (const c of clients) c.ws.close();
});
