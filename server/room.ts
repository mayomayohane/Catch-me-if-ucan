import { randomUUID } from 'node:crypto';
import {
  CAPTURE_REQUEST_TTL_MS,
  DURATIONS,
  MAX_PLAYERS,
  PHOTO_INTERVAL_MS,
  TEAM_MODES,
  clampRadius,
  defaultSettings,
  dueMissionCount,
  haversineM,
  isOutsideArea,
  isRoleFull,
  isValidLatLng,
  nextMissionAt,
  startBlockers,
  type LatLng,
  type Phase,
  type Role,
  type Settings,
} from '../src/shared/game.ts';
import type { ClientMessage, PhotoView, ResultView, RoomView, TrackPoint } from '../src/shared/protocol.ts';

export class GameError extends Error {}

const TRACK_MIN_INTERVAL_MS = 5000;
const NAME_MAX = 16;

interface Player {
  id: string;
  /** Secret reconnect key held only by the player's device. */
  key: string;
  name: string;
  role: Role | null;
  ready: boolean;
  connected: boolean;
  captured: boolean;
  violation: boolean;
  pos?: LatLng & { t: number; acc?: number };
  submittedMissions: Set<number>;
  track: TrackPoint[];
}

interface CaptureRequest {
  id: string;
  chaserId: string;
  runnerId: string;
  expiresAt: number;
  distanceM: number | null;
}

export interface RoomOptions {
  now?: () => number;
  photoIntervalMs?: number;
}

export function sanitizeName(name: unknown): string {
  const s = typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : '';
  return s || 'プレイヤー';
}

export class Room {
  phase: Phase = 'lobby';
  hostId = '';
  settings: Settings = defaultSettings();
  players = new Map<string, Player>();
  startedAt: number | null = null;
  endsAt: number | null = null;
  photos: PhotoView[] = [];
  captureRequests: CaptureRequest[] = [];
  result: ResultView | null = null;
  lastActivity: number;
  private now: () => number;
  private photoIntervalMs: number;
  private lastMissionCount = 0;

  constructor(public readonly code: string, opts: RoomOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.photoIntervalMs = opts.photoIntervalMs ?? PHOTO_INTERVAL_MS;
    this.lastActivity = this.now();
  }

  /** Adds a player, or reconnects an existing one holding the same key. Returns the player id. */
  join(key: string, name: unknown): string {
    if (typeof key !== 'string' || key.length < 8) throw new GameError('不正なクライアントです');
    const existing = this.findByKey(key);
    if (existing) {
      existing.connected = true;
      if (this.phase === 'lobby') existing.name = sanitizeName(name);
      return existing.id;
    }
    if (this.phase !== 'lobby') throw new GameError('このルームはすでにゲーム中です');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('ルームが満員です（最大5人）');
    const id = randomUUID().slice(0, 8);
    this.players.set(id, {
      id, key, name: sanitizeName(name), role: null, ready: false, connected: true,
      captured: false, violation: false, submittedMissions: new Set(), track: [],
    });
    if (!this.hostId) this.hostId = id;
    this.touch();
    return id;
  }

  findByKey(key: string): Player | undefined {
    for (const p of this.players.values()) if (p.key === key) return p;
    return undefined;
  }

  /** Explicit leave. In the lobby the player is removed; mid-game they are only marked offline. */
  leave(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(playerId);
      if (this.hostId === playerId) this.hostId = this.players.keys().next().value ?? '';
    } else {
      p.connected = false;
    }
    this.touch();
  }

  disconnect(playerId: string): void {
    const p = this.players.get(playerId);
    if (p) p.connected = false;
  }

  get isEmpty(): boolean {
    return [...this.players.values()].every((p) => !p.connected);
  }

  handle(playerId: string, msg: ClientMessage): void {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('ルームに参加していません');
    this.touch();
    switch (msg.type) {
      case 'setRole': return this.setRole(p, msg.role);
      case 'setSettings': return this.setSettings(p, msg);
      case 'setReady': return this.setReady(p, msg.ready);
      case 'start': return this.start(p);
      case 'location': return this.updateLocation(p, msg);
      case 'requestCapture': return this.requestCapture(p, msg.runnerId);
      case 'respondCapture': return this.respondCapture(p, msg.requestId, msg.accept);
      default: throw new GameError('不明な操作です');
    }
  }

  private requireLobby() {
    if (this.phase !== 'lobby') throw new GameError('ゲーム開始後は変更できません');
  }

  private requirePlaying() {
    if (this.phase !== 'playing') throw new GameError('ゲーム中ではありません');
  }

  private setRole(p: Player, role: Role | null) {
    this.requireLobby();
    if (role !== null && role !== 'runner' && role !== 'chaser') throw new GameError('不正な役割です');
    if (role && p.role !== role && isRoleFull([...this.players.values()], this.settings.teamMode, role)) {
      throw new GameError('その役割は定員に達しています');
    }
    p.role = role;
    p.ready = false;
  }

  private setSettings(p: Player, msg: Extract<ClientMessage, { type: 'setSettings' }>) {
    this.requireLobby();
    if (p.id !== this.hostId) throw new GameError('設定を変更できるのはホストだけです');
    if (msg.teamMode !== undefined) {
      if (!(msg.teamMode in TEAM_MODES)) throw new GameError('不正なチーム構成です');
      this.settings.teamMode = msg.teamMode;
      // Drop players who no longer fit in their role under the new caps (latest joiners first).
      for (const role of ['runner', 'chaser'] as const) {
        const holders = [...this.players.values()].filter((x) => x.role === role);
        for (const x of holders.slice(TEAM_MODES[msg.teamMode][role])) {
          x.role = null;
          x.ready = false;
        }
      }
    }
    if (msg.center !== undefined) {
      if (!isValidLatLng(msg.center)) throw new GameError('不正な座標です');
      this.settings.center = { lat: msg.center.lat, lng: msg.center.lng };
    }
    if (msg.radiusM !== undefined) {
      if (typeof msg.radiusM !== 'number' || !Number.isFinite(msg.radiusM)) throw new GameError('不正な半径です');
      this.settings.radiusM = clampRadius(msg.radiusM);
    }
    if (msg.durationMin !== undefined) {
      if (!DURATIONS.includes(msg.durationMin)) throw new GameError('不正なゲーム時間です');
      this.settings.durationMin = msg.durationMin;
    }
  }

  private setReady(p: Player, ready: boolean) {
    this.requireLobby();
    if (ready && !p.role) throw new GameError('先に役割を選んでください');
    p.ready = !!ready;
  }

  private start(p: Player) {
    this.requireLobby();
    if (p.id !== this.hostId) throw new GameError('ゲームを開始できるのはホストだけです');
    const blockers = startBlockers([...this.players.values()], this.settings);
    if (blockers.length) throw new GameError(blockers[0]);
    const now = this.now();
    this.phase = 'playing';
    this.startedAt = now;
    this.endsAt = now + this.settings.durationMin * 60_000;
    this.lastMissionCount = 0;
    for (const x of this.players.values()) {
      x.track = x.pos ? [[x.pos.lat, x.pos.lng, now]] : [];
      this.refreshViolation(x);
    }
  }

  private updateLocation(p: Player, msg: Extract<ClientMessage, { type: 'location' }>) {
    if (!isValidLatLng(msg)) throw new GameError('不正な座標です');
    const now = this.now();
    const acc = typeof msg.acc === 'number' && Number.isFinite(msg.acc) ? Math.round(msg.acc) : undefined;
    p.pos = { lat: msg.lat, lng: msg.lng, t: now, acc };
    if (this.phase !== 'playing') return;
    const last = p.track[p.track.length - 1];
    if (!last || now - last[2] >= TRACK_MIN_INTERVAL_MS) p.track.push([msg.lat, msg.lng, now]);
    this.refreshViolation(p);
  }

  private refreshViolation(p: Player) {
    const c = this.settings.center;
    p.violation = this.phase === 'playing' && p.role === 'runner' && !p.captured && !!p.pos && !!c &&
      isOutsideArea(p.pos, c, this.settings.radiusM);
  }

  private requestCapture(p: Player, runnerId: string) {
    this.requirePlaying();
    if (p.role !== 'chaser') throw new GameError('確保できるのは追跡者だけです');
    const runner = this.players.get(runnerId);
    if (!runner || runner.role !== 'runner') throw new GameError('対象の逃走者が見つかりません');
    if (runner.captured) throw new GameError('その逃走者はすでに確保済みです');
    if (this.captureRequests.some((r) => r.chaserId === p.id && r.runnerId === runnerId)) return;
    this.captureRequests.push({
      id: randomUUID().slice(0, 8),
      chaserId: p.id,
      runnerId,
      expiresAt: this.now() + CAPTURE_REQUEST_TTL_MS,
      distanceM: p.pos && runner.pos ? Math.round(haversineM(p.pos, runner.pos)) : null,
    });
  }

  private respondCapture(p: Player, requestId: string, accept: boolean) {
    this.requirePlaying();
    const req = this.captureRequests.find((r) => r.id === requestId);
    if (!req) throw new GameError('確保リクエストの期限が切れています');
    if (req.runnerId !== p.id) throw new GameError('このリクエストには応答できません');
    if (!accept) {
      this.captureRequests = this.captureRequests.filter((r) => r.id !== requestId);
      return;
    }
    p.captured = true;
    p.violation = false;
    this.captureRequests = this.captureRequests.filter((r) => r.runnerId !== p.id);
    if (this.runners().every((r) => r.captured)) this.finish('chaser', 'all_captured');
  }

  addPhoto(key: string, mission: number, url: string, pos: LatLng | null): PhotoView {
    this.requirePlaying();
    const p = this.findByKey(key);
    if (!p) throw new GameError('ルームに参加していません');
    if (p.role !== 'runner' || p.captured) throw new GameError('自撮りミッションの対象ではありません');
    if (!this.pendingMissions(p).includes(mission)) throw new GameError('このミッションは送信済みか、まだ始まっていません');
    p.submittedMissions.add(mission);
    const photo: PhotoView = {
      id: randomUUID().slice(0, 8),
      playerId: p.id,
      playerName: p.name,
      url,
      pos: pos && isValidLatLng(pos) ? { lat: pos.lat, lng: pos.lng } : p.pos ? { lat: p.pos.lat, lng: p.pos.lng } : null,
      t: this.now(),
      mission,
    };
    this.photos.push(photo);
    this.touch();
    return photo;
  }

  private runners(): Player[] {
    return [...this.players.values()].filter((p) => p.role === 'runner');
  }

  private pendingMissions(p: Player): number[] {
    if (this.phase !== 'playing' || p.role !== 'runner' || p.captured || !this.startedAt || !this.endsAt) return [];
    const due = dueMissionCount(this.startedAt, this.endsAt, this.now(), this.photoIntervalMs);
    const out: number[] = [];
    for (let m = 1; m <= due; m++) if (!p.submittedMissions.has(m)) out.push(m);
    return out;
  }

  private finish(winner: Role, reason: ResultView['reason']) {
    this.phase = 'finished';
    this.captureRequests = [];
    const tracks: ResultView['tracks'] = {};
    for (const p of this.players.values()) {
      tracks[p.id] = p.track;
      p.violation = false;
    }
    this.result = { winner, reason, tracks, endedAt: this.now() };
  }

  /** Advances time-based state. Returns true when clients should receive a fresh view. */
  tick(): boolean {
    if (this.phase !== 'playing' || !this.startedAt || !this.endsAt) return false;
    const now = this.now();
    if (now >= this.endsAt) {
      this.finish('runner', 'time_up');
      return true;
    }
    let changed = false;
    const before = this.captureRequests.length;
    this.captureRequests = this.captureRequests.filter((r) => r.expiresAt > now);
    if (this.captureRequests.length !== before) changed = true;
    const missions = dueMissionCount(this.startedAt, this.endsAt, now, this.photoIntervalMs);
    if (missions !== this.lastMissionCount) {
      this.lastMissionCount = missions;
      changed = true;
    }
    return changed;
  }

  private touch() {
    this.lastActivity = this.now();
  }

  /** Builds the per-viewer view, hiding information that viewer must not see. */
  view(viewerId: string): RoomView {
    const viewer = this.players.get(viewerId);
    const finished = this.phase === 'finished';
    const players = [...this.players.values()].map((p) => {
      const sameTeam = !!viewer?.role && viewer.role === p.role;
      const exposedRunner = viewer?.role === 'chaser' && p.role === 'runner' && p.violation;
      const visible = p.id === viewerId || finished || (this.phase === 'playing' && (sameTeam || exposedRunner));
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        ready: p.ready,
        connected: p.connected,
        isHost: p.id === this.hostId,
        captured: p.captured,
        violation: p.violation,
        ...(visible && p.pos ? { pos: p.pos } : {}),
      };
    });
    const now = this.now();
    return {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      players,
      meId: viewerId,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      nextMissionAt: this.phase === 'playing' && this.startedAt && this.endsAt
        ? nextMissionAt(this.startedAt, this.endsAt, now, this.photoIntervalMs)
        : null,
      myPendingMissions: viewer ? this.pendingMissions(viewer) : [],
      photos: this.photos,
      captureRequests: this.captureRequests.filter(
        (r) => r.runnerId === viewerId || r.chaserId === viewerId || viewer?.role === 'chaser',
      ),
      result: this.result,
    };
  }
}
