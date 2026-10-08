// Shapes returned by the Supabase RPCs (see supabase/migrations) and the client's action messages.

import type { DurationMin, LatLng, Phase, Role, Settings, TeamMode } from './game.ts';

export interface PlayerView {
  id: string;
  name: string;
  role: Role | null;
  ready: boolean;
  /** From Realtime presence (true until presence has synced). */
  connected: boolean;
  isHost: boolean;
  captured: boolean;
  /** Runner is outside the area. Visible to everyone. */
  violation: boolean;
  /** Only present when the viewer is allowed to see this player's location. */
  pos?: LatLng & { t: number; acc?: number };
}

export interface PhotoView {
  id: string;
  playerId: string;
  playerName: string;
  /** Object path in the `drokei-photos` storage bucket. */
  path: string;
  /** Public URL, filled in by the client. */
  url: string;
  pos: LatLng | null;
  t: number;
  mission: number;
}

export interface CaptureRequestView {
  id: string;
  chaserId: string;
  runnerId: string;
  expiresAt: number;
  /** Distance between the two players at request time, if both locations are known. */
  distanceM: number | null;
}

/** [lat, lng, timestamp] */
export type TrackPoint = [number, number, number];

export interface ResultView {
  winner: Role;
  reason: 'all_captured' | 'time_up' | 'no_runners';
  tracks: Record<string, TrackPoint[]>;
  endedAt: number;
}

export interface RoomView {
  code: string;
  phase: Phase;
  settings: Settings;
  players: PlayerView[];
  meId: string;
  startedAt: number | null;
  endsAt: number | null;
  nextMissionAt: number | null;
  /** 1-based mission numbers the viewer (a runner) still has to submit. */
  myPendingMissions: number[];
  photos: PhotoView[];
  captureRequests: CaptureRequestView[];
  result: ResultView | null;
}

/** Actions a player can take; each maps to one RPC in net.ts. */
export type ClientMessage =
  | { type: 'leave' }
  | { type: 'setRole'; role: Role | null }
  | { type: 'setSettings'; teamMode?: TeamMode; center?: LatLng; radiusM?: number; durationMin?: DurationMin; photoIntervalS?: number }
  | { type: 'setReady'; ready: boolean }
  | { type: 'start' }
  | { type: 'location'; lat: number; lng: number; acc?: number }
  | { type: 'requestCapture'; runnerId: string }
  | { type: 'respondCapture'; requestId: string; accept: boolean };

/** Every mutating RPC returns the caller's fresh view. */
export interface RpcResponse {
  room: RoomView;
  serverNow: number;
}

export const PHOTO_BUCKET = 'drokei-photos';
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
