import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dueMissionCount,
  formatClock,
  haversineM,
  isOutsideArea,
  isRoleFull,
  missionTimes,
  nextMissionAt,
  startBlockers,
  defaultSettings,
  nearMisses,
  positionAt,
  proximityBand,
} from '../src/shared/game.ts';

const TOKYO_STATION = { lat: 35.681236, lng: 139.767125 };

test('haversine matches known distances', () => {
  assert.equal(haversineM(TOKYO_STATION, TOKYO_STATION), 0);
  // One degree of latitude is ~111.2 km.
  const d = haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(d - 111_195) < 50, `got ${d}`);
  // Tokyo Station -> Shinjuku Station is ~6.2 km.
  const shinjuku = { lat: 35.690921, lng: 139.700258 };
  const d2 = haversineM(TOKYO_STATION, shinjuku);
  assert.ok(d2 > 6000 && d2 < 6400, `got ${d2}`);
});

test('area check uses the radius boundary', () => {
  // ~0.027 deg latitude is ~3 km.
  assert.equal(isOutsideArea({ lat: TOKYO_STATION.lat + 0.026, lng: TOKYO_STATION.lng }, TOKYO_STATION, 3000), false);
  assert.equal(isOutsideArea({ lat: TOKYO_STATION.lat + 0.028, lng: TOKYO_STATION.lng }, TOKYO_STATION, 3000), true);
});

test('selfie missions fire every 10 minutes before the end', () => {
  const start = 1_000_000;
  const min = 60_000;
  assert.deepEqual(missionTimes(start, start + 30 * min), [start + 10 * min, start + 20 * min]);
  assert.equal(missionTimes(start, start + 60 * min).length, 5);
  assert.equal(dueMissionCount(start, start + 30 * min, start + 9 * min), 0);
  assert.equal(dueMissionCount(start, start + 30 * min, start + 10 * min), 1);
  assert.equal(dueMissionCount(start, start + 30 * min, start + 29 * min), 2);
  assert.equal(nextMissionAt(start, start + 30 * min, start), start + 10 * min);
  assert.equal(nextMissionAt(start, start + 30 * min, start + 25 * min), null);
});

test('role capacity and start conditions follow the team mode', () => {
  const s = { ...defaultSettings(), teamMode: '1v4' as const };
  const players = [
    { role: 'runner' as const, ready: true },
    { role: 'chaser' as const, ready: true },
  ];
  assert.equal(isRoleFull(players, '1v4', 'runner'), true);
  assert.equal(isRoleFull(players, '1v4', 'chaser'), false);
  const blockers = startBlockers(players, s);
  assert.ok(blockers.some((b) => b.includes('中心ピン')));
  assert.ok(blockers.some((b) => b.includes('追跡者を4人')));
  const full = [{ role: 'runner' as const, ready: true }, ...Array(4).fill({ role: 'chaser', ready: true })];
  assert.deepEqual(startBlockers(full, { ...s, center: TOKYO_STATION }), []);
});

test('formatClock', () => {
  assert.equal(formatClock(28 * 60_000 + 45_000), '28:45');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatClock(75_000), '01:15');
});

test('proximity bands', () => {
  assert.equal(proximityBand(null), null);
  assert.equal(proximityBand(15), 20);
  assert.equal(proximityBand(20), 20);
  assert.equal(proximityBand(49), 50);
  assert.equal(proximityBand(100), 100);
  assert.equal(proximityBand(101), null);
});

test('positionAt interpolates and clamps', () => {
  const track = [[35, 139, 1000], [35.002, 139.002, 3000]] as const;
  assert.equal(positionAt(track, 999), null);
  const mid = positionAt(track, 2000)!;
  assert.ok(Math.abs(mid.lat - 35.001) < 1e-9 && Math.abs(mid.lng - 139.001) < 1e-9);
  assert.deepEqual(positionAt(track, 9999), { lat: 35.002, lng: 139.002 });
  assert.equal(positionAt([], 0), null);
});

test('nearMisses finds the closest separate encounters', () => {
  const MIN = 60_000;
  const base = { lat: 35.68, lng: 139.76 };
  // Runner walks north; chaser walks south along a parallel street ~30 m east, so they pass at t=10 min.
  const runner = [[base.lat - 0.01, base.lng, 0], [base.lat + 0.01, base.lng, 20 * MIN]] as const;
  const chaser = [[base.lat + 0.01, base.lng + 0.0003, 0], [base.lat - 0.01, base.lng + 0.0003, 20 * MIN]] as const;
  // A second chaser far away never gets close.
  const far = [[base.lat, base.lng + 0.05, 0], [base.lat, base.lng + 0.05, 20 * MIN]] as const;
  const misses = nearMisses([{ id: 'r', track: runner }], [{ id: 'c', track: chaser }, { id: 'far', track: far }]);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].chaserId, 'c');
  assert.ok(Math.abs(misses[0].t - 10 * MIN) <= 5000, `t=${misses[0].t}`);
  assert.ok(misses[0].distanceM >= 25 && misses[0].distanceM <= 35, `d=${misses[0].distanceM}`);
});
