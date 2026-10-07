import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameError, Room } from '../server/room.ts';

const CENTER = { lat: 35.681236, lng: 139.767125 };
const INSIDE = { lat: CENTER.lat + 0.01, lng: CENTER.lng };
const OUTSIDE = { lat: CENTER.lat + 0.05, lng: CENTER.lng };
const MIN = 60_000;

function setup(teamMode: '1v4' | '2v3' | '3v2' = '2v3') {
  let now = 1_000_000;
  const room = new Room('12345', { now: () => now });
  const ids = ['a', 'b', 'c', 'd', 'e'].map((n) => room.join(`key-${n}-xxxxxxxx`, n));
  const host = ids[0];
  room.handle(host, { type: 'setSettings', teamMode, center: CENTER });
  const runnerCount = Number(teamMode[0]);
  ids.forEach((id, i) => {
    room.handle(id, { type: 'setRole', role: i < runnerCount ? 'runner' : 'chaser' });
    room.handle(id, { type: 'setReady', ready: true });
  });
  return {
    room,
    ids,
    host,
    runners: ids.slice(0, runnerCount),
    chasers: ids.slice(runnerCount),
    advance: (ms: number) => { now += ms; },
  };
}

test('lobby enforces capacity, host-only settings, and start conditions', () => {
  const room = new Room('11111');
  const ids = ['a', 'b', 'c', 'd', 'e'].map((n) => room.join(`key-${n}-xxxxxxxx`, n));
  assert.throws(() => room.join('key-f-xxxxxxxx', 'f'), GameError);
  assert.throws(() => room.handle(ids[1], { type: 'setSettings', radiusM: 1000 }), /ホスト/);
  room.handle(ids[0], { type: 'setSettings', teamMode: '1v4' });
  room.handle(ids[0], { type: 'setRole', role: 'runner' });
  assert.throws(() => room.handle(ids[1], { type: 'setRole', role: 'runner' }), /定員/);
  assert.throws(() => room.handle(ids[0], { type: 'start' }), /中心ピン/);
  // Switching to 3v2 lets more runners in; switching back drops the overflow.
  room.handle(ids[0], { type: 'setSettings', teamMode: '3v2' });
  room.handle(ids[1], { type: 'setRole', role: 'runner' });
  room.handle(ids[0], { type: 'setSettings', teamMode: '1v4' });
  assert.equal(room.view(ids[0]).players.filter((p) => p.role === 'runner').length, 1);
  // Radius is clamped.
  room.handle(ids[0], { type: 'setSettings', radiusM: 99_999 });
  assert.equal(room.settings.radiusM, 10_000);
});

test('reconnecting with the same key keeps the same player, even mid-game', () => {
  const { room, ids } = setup();
  room.handle(ids[0], { type: 'start' });
  room.disconnect(ids[2]);
  assert.equal(room.join('key-c-xxxxxxxx', 'c'), ids[2]);
  assert.throws(() => room.join('key-new-xxxxxxxx', 'x'), /ゲーム中/);
});

test('runner locations are hidden from chasers until they leave the area', () => {
  const { room, host, runners, chasers } = setup();
  room.handle(host, { type: 'start' });
  const [r1, r2] = runners;
  room.handle(r1, { type: 'location', ...INSIDE });
  room.handle(chasers[0], { type: 'location', ...INSIDE });

  const chaserView = () => room.view(chasers[0]).players.find((p) => p.id === r1)!;
  assert.equal(chaserView().pos, undefined);
  assert.equal(chaserView().violation, false);
  // Runners never see chasers, but do see their teammates.
  assert.equal(room.view(r2).players.find((p) => p.id === chasers[0])!.pos, undefined);
  assert.ok(room.view(r2).players.find((p) => p.id === r1)!.pos);

  room.handle(r1, { type: 'location', ...OUTSIDE });
  assert.equal(chaserView().violation, true);
  assert.deepEqual({ lat: chaserView().pos!.lat, lng: chaserView().pos!.lng }, OUTSIDE);

  room.handle(r1, { type: 'location', ...INSIDE });
  assert.equal(chaserView().violation, false);
  assert.equal(chaserView().pos, undefined);
});

test('selfie missions become pending every 10 minutes and accept one photo each', () => {
  const { room, host, runners, chasers, advance } = setup();
  room.handle(host, { type: 'start' });
  const key = 'key-a-xxxxxxxx';
  assert.deepEqual(room.view(runners[0]).myPendingMissions, []);
  assert.throws(() => room.addPhoto(key, 1, '/photos/x.jpg', null), /ミッション/);

  advance(10 * MIN);
  assert.equal(room.tick(), true);
  assert.deepEqual(room.view(runners[0]).myPendingMissions, [1]);
  assert.deepEqual(room.view(chasers[0]).myPendingMissions, []);
  assert.throws(() => room.addPhoto('key-c-xxxxxxxx', 1, '/photos/x.jpg', null), /対象ではありません/);

  const photo = room.addPhoto(key, 1, '/photos/x.jpg', INSIDE);
  assert.deepEqual(photo.pos, INSIDE);
  assert.deepEqual(room.view(runners[0]).myPendingMissions, []);
  assert.throws(() => room.addPhoto(key, 1, '/photos/y.jpg', null), /送信済み/);
  assert.equal(room.view(chasers[0]).photos.length, 1);

  // Missions that were missed stay pending.
  advance(10 * MIN);
  room.tick();
  assert.deepEqual(room.view(runners[1]).myPendingMissions, [1, 2]);
});

test('capture needs the runner to confirm; all captured means chasers win', () => {
  const { room, host, runners, chasers } = setup('1v4');
  room.handle(host, { type: 'start' });
  const [runner] = runners;
  assert.throws(() => room.handle(runner, { type: 'requestCapture', runnerId: runner }), /追跡者だけ/);

  room.handle(chasers[0], { type: 'requestCapture', runnerId: runner });
  const req = room.view(runner).captureRequests[0];
  assert.ok(req);
  assert.throws(() => room.handle(chasers[1], { type: 'respondCapture', requestId: req.id, accept: true }), /応答できません/);

  room.handle(runner, { type: 'respondCapture', requestId: req.id, accept: false });
  assert.equal(room.phase, 'playing');

  room.handle(chasers[0], { type: 'requestCapture', runnerId: runner });
  const req2 = room.view(runner).captureRequests[0];
  room.handle(runner, { type: 'respondCapture', requestId: req2.id, accept: true });
  assert.equal(room.phase, 'finished');
  assert.equal(room.result?.winner, 'chaser');
  assert.equal(room.result?.reason, 'all_captured');
});

test('capture requests expire', () => {
  const { room, host, runners, chasers, advance } = setup();
  room.handle(host, { type: 'start' });
  room.handle(chasers[0], { type: 'requestCapture', runnerId: runners[0] });
  advance(61_000);
  assert.equal(room.tick(), true);
  assert.equal(room.view(runners[0]).captureRequests.length, 0);
});

test('runners win when time runs out; result exposes all tracks', () => {
  const { room, host, runners, advance } = setup();
  room.handle(host, { type: 'start' });
  room.handle(runners[0], { type: 'location', ...INSIDE });
  advance(6000);
  room.handle(runners[0], { type: 'location', ...OUTSIDE });
  advance(30 * MIN);
  assert.equal(room.tick(), true);
  assert.equal(room.phase, 'finished');
  assert.equal(room.result?.winner, 'runner');
  assert.equal(room.result?.tracks[runners[0]].length, 2);
  // After the game, everyone can see everyone's last position.
  assert.ok(room.view(runners[1]).players.every((p) => p.id === runners[1] || p.pos || !room.players.get(p.id)!.pos));
});
