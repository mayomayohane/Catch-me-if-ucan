// Game rules shared by the server (authoritative) and the client (display).

export type Role = 'runner' | 'chaser';
export type TeamMode = '1v4' | '2v3' | '3v2';
export type Phase = 'lobby' | 'playing' | 'finished';

export interface LatLng {
  lat: number;
  lng: number;
}

export const TEAM_MODES: Record<TeamMode, { runner: number; chaser: number; label: string; desc: string }> = {
  '1v4': { runner: 1, chaser: 4, label: '1 vs 4', desc: '高難易度・スリル重視' },
  '2v3': { runner: 2, chaser: 3, label: '2 vs 3', desc: '標準バランス' },
  '3v2': { runner: 3, chaser: 2, label: '3 vs 2', desc: 'エンタメ重視' },
};

export const MAX_PLAYERS = 5;
export const DURATIONS = [30, 45, 60] as const;
export type DurationMin = (typeof DURATIONS)[number];

export const DEFAULT_RADIUS_M = 3000;
export const MIN_RADIUS_M = 500;
export const MAX_RADIUS_M = 10000;
export const PHOTO_INTERVAL_MS = 10 * 60 * 1000;
/** Selfie interval choices in seconds. Anything shorter than 10 min is demo mode. */
export const PHOTO_INTERVALS_S = [600, 60, 30] as const;
export const DEFAULT_PHOTO_INTERVAL_S = 600;

export function formatInterval(s: number): string {
  return s >= 60 ? `${Math.round(s / 60)}分` : `${s}秒`;
}
export const CAPTURE_REQUEST_TTL_MS = 60 * 1000;

export interface Settings {
  teamMode: TeamMode;
  center: LatLng | null;
  radiusM: number;
  durationMin: DurationMin;
  /** Seconds between selfie missions (600 normally; shorter in demo mode). */
  photoIntervalS: number;
  /** Footprint radar window: runners' trail from (delay + span) to delay seconds ago; span 0 = off. */
  footprintDelayS: number;
  footprintSpanS: number;
  /** How many candidate places (parks, stations...) the host found for items. */
  spotCandidates: number;
}

export const defaultSettings = (): Settings => ({
  teamMode: '2v3',
  center: null,
  radiusM: DEFAULT_RADIUS_M,
  durationMin: 30,
  photoIntervalS: DEFAULT_PHOTO_INTERVAL_S,
  footprintDelayS: 300,
  footprintSpanS: 600,
  spotCandidates: 0,
});

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in meters (Haversine formula). */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isOutsideArea(pos: LatLng, center: LatLng, radiusM: number): boolean {
  return haversineM(pos, center) > radiusM;
}

export function isValidLatLng(v: unknown): v is LatLng {
  if (!v || typeof v !== 'object') return false;
  const { lat, lng } = v as LatLng;
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}

export const clampRadius = (m: number) => Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, m)));

/**
 * Selfie missions fire every PHOTO_INTERVAL_MS after the start, while the game is running.
 * Mission n (1-based) is due at startedAt + n * interval, provided that is before endsAt.
 */
export function missionTimes(startedAt: number, endsAt: number, intervalMs = PHOTO_INTERVAL_MS): number[] {
  const times: number[] = [];
  for (let t = startedAt + intervalMs; t < endsAt; t += intervalMs) times.push(t);
  return times;
}

/** Number of missions that have become due by `now`. */
export function dueMissionCount(startedAt: number, endsAt: number, now: number, intervalMs = PHOTO_INTERVAL_MS): number {
  return missionTimes(startedAt, endsAt, intervalMs).filter((t) => t <= now).length;
}

export function nextMissionAt(startedAt: number, endsAt: number, now: number, intervalMs = PHOTO_INTERVAL_MS): number | null {
  return missionTimes(startedAt, endsAt, intervalMs).find((t) => t > now) ?? null;
}

export interface LobbyPlayer {
  role: Role | null;
  ready: boolean;
}

export function roleCount(players: LobbyPlayer[], role: Role): number {
  return players.filter((p) => p.role === role).length;
}

export function isRoleFull(players: LobbyPlayer[], mode: TeamMode, role: Role): boolean {
  return roleCount(players, role) >= TEAM_MODES[mode][role];
}

/** Returns the reasons the game cannot start yet (empty when it can). */
export function startBlockers(players: LobbyPlayer[], settings: Settings): string[] {
  const reasons: string[] = [];
  const mode = TEAM_MODES[settings.teamMode];
  if (!settings.center) reasons.push('中心ピンが未設定です');
  if (roleCount(players, 'runner') !== mode.runner) reasons.push(`逃走者を${mode.runner}人にしてください`);
  if (roleCount(players, 'chaser') !== mode.chaser) reasons.push(`追跡者を${mode.chaser}人にしてください`);
  if (players.some((p) => !p.ready)) reasons.push('全員の準備完了を待っています');
  return reasons;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---- Footprints (radar) ----------------------------------------------------

/** Chasers see where runners were between (delay + span) and delay seconds ago. */
export const FOOTPRINT_PRESETS = [
  { key: 'normal', label: '5〜15分前', desc: '通常', delayS: 300, spanS: 600 },
  { key: 'demo', label: '1〜3分前', desc: 'デモ・お試し用', delayS: 60, spanS: 120 },
  { key: 'off', label: 'なし', desc: '足跡を出さない', delayS: 0, spanS: 0 },
] as const;

// ---- Proximity alert -------------------------------------------------------

/** Distance bands (meters) reported by the server; GPS noise makes finer steps meaningless. */
export const PROXIMITY_BANDS_M = [20, 50, 100] as const;
export type ProximityBand = (typeof PROXIMITY_BANDS_M)[number];

/** Heartbeat period per band: the closer, the faster. */
export const HEARTBEAT_MS: Record<ProximityBand, number> = { 100: 1200, 50: 800, 20: 480 };

export function proximityBand(distanceM: number | null): ProximityBand | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  return PROXIMITY_BANDS_M.find((b) => distanceM <= b) ?? null;
}

// ---- Replay ----------------------------------------------------------------

/** [lat, lng, timestamp ms], sorted by time. */
export type Track = ReadonlyArray<readonly [number, number, number]>;

/** Position at time t, linearly interpolated. Null before the first point; the last point after the end. */
export function positionAt(track: Track, t: number): LatLng | null {
  if (!track.length || t < track[0][2]) return null;
  let lo = 0;
  let hi = track.length - 1;
  if (t >= track[hi][2]) return { lat: track[hi][0], lng: track[hi][1] };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid][2] <= t) lo = mid;
    else hi = mid;
  }
  const [aLat, aLng, aT] = track[lo];
  const [bLat, bLng, bT] = track[hi];
  const f = bT === aT ? 0 : (t - aT) / (bT - aT);
  return { lat: aLat + (bLat - aLat) * f, lng: aLng + (bLng - aLng) * f };
}

export interface NearMiss {
  runnerId: string;
  chaserId: string;
  t: number;
  distanceM: number;
}

/**
 * Finds the closest runner–chaser encounters for the replay ("スレスレ" moments).
 * Samples every pair every `stepMs`, keeps local minima under `maxDistanceM`, then picks the
 * closest ones at least `minGapMs` apart so the highlights are different scenes.
 */
export function nearMisses(
  runners: Array<{ id: string; track: Track }>,
  chasers: Array<{ id: string; track: Track }>,
  { stepMs = 5000, maxDistanceM = 200, minGapMs = 60_000, limit = 3 } = {},
): NearMiss[] {
  const candidates: NearMiss[] = [];
  for (const r of runners) {
    for (const c of chasers) {
      if (!r.track.length || !c.track.length) continue;
      const from = Math.max(r.track[0][2], c.track[0][2]);
      const to = Math.min(r.track[r.track.length - 1][2], c.track[c.track.length - 1][2]);
      const samples: Array<{ t: number; d: number }> = [];
      for (let t = from; t <= to; t += stepMs) {
        const a = positionAt(r.track, t);
        const b = positionAt(c.track, t);
        if (a && b) samples.push({ t, d: haversineM(a, b) });
      }
      samples.forEach((s, i) => {
        const prev = samples[i - 1]?.d ?? Infinity;
        const next = samples[i + 1]?.d ?? Infinity;
        if (s.d <= maxDistanceM && s.d <= prev && s.d < next) {
          candidates.push({ runnerId: r.id, chaserId: c.id, t: s.t, distanceM: Math.round(s.d) });
        }
      });
    }
  }
  candidates.sort((a, b) => a.distanceM - b.distanceM || a.t - b.t);
  const picked: NearMiss[] = [];
  for (const m of candidates) {
    if (picked.length >= limit) break;
    if (picked.every((p) => Math.abs(p.t - m.t) >= minGapMs)) picked.push(m);
  }
  return picked.sort((a, b) => a.t - b.t);
}

// ---- Items & points --------------------------------------------------------

/** Walk within this distance of an item / challenge spot to use it (checked on the server too). */
export const SPOT_RADIUS_M = 40;

export type ItemType = 'invisible' | 'decoy' | 'radar';

export const ITEM_INFO: Record<ItemType, { icon: string; name: string; desc: string }> = {
  invisible: { icon: '🫥', name: '透明化', desc: '次の自撮りミッションを1回スキップできる' },
  decoy: { icon: '👣', name: '偽の足跡', desc: '地図の好きな場所に「目撃情報」を5分間出して追跡者を惑わせる' },
  radar: { icon: '📡', name: '10秒GPSレーダー', desc: '逃走者全員の現在地を10秒間マップに表示する' },
};

/** Mirrors the scoring in supabase/migrations/*_view_items_points.sql (for the rules screen). */
export const POINTS = {
  perMinuteAlive: 1,
  selfie: 5,
  escape: 30,
  challengeMultiplier: 3,
  capture: 50,
  chaserWin: 20,
} as const;

/** Mission number used for the 🔥 challenge selfie. */
export const CHALLENGE_MISSION = 0;
