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
}

export const defaultSettings = (): Settings => ({
  teamMode: '2v3',
  center: null,
  radiusM: DEFAULT_RADIUS_M,
  durationMin: 30,
  photoIntervalS: DEFAULT_PHOTO_INTERVAL_S,
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
