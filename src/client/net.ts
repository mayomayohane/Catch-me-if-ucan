import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { PHOTO_BUCKET, type ClientMessage, type RoomView, type RpcResponse } from '../shared/protocol.ts';
import type { LatLng } from '../shared/game.ts';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set (see .env.example)');
}

// No Supabase Auth: players are identified by a secret device key passed to each RPC.
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const STORAGE = { key: 'cmiu.key', name: 'cmiu.name', code: 'cmiu.code' };
/** Safety-net refresh in case a Realtime ping is missed. */
const POLL_MS = 15_000;
/** Coalesces bursts of pings (e.g. several players moving) into one fetch. */
const REFRESH_DEBOUNCE_MS = 250;
/** Errors after which a saved room is no longer worth resuming. */
const GONE = ['ルームが見つかりません', 'ルームに参加していません', 'このルームはすでにゲーム中です', 'ルームが満員です'];

function load(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function save(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable (private mode) — reconnect just won't survive reloads */
  }
}

function makeKey(): string {
  return crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ClientState {
  connected: boolean;
  room: RoomView | null;
  /** serverNow - Date.now(), so `Date.now() + offset` approximates server time. */
  offset: number;
  error: string | null;
  name: string;
}

class GameClient {
  readonly key: string;
  private listeners = new Set<() => void>();
  private code: string | null = null;
  private channel: RealtimeChannel | null = null;
  private online: Set<string> | null = null;
  private lastServerNow = 0;
  private raw: RoomView | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private eventTimer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  state: ClientState;

  constructor() {
    let key = load(STORAGE.key);
    if (!key) {
      key = makeKey();
      save(STORAGE.key, key);
    }
    this.key = key;
    this.state = { connected: navigator.onLine, room: null, offset: 0, error: null, name: load(STORAGE.name) ?? '' };
    window.addEventListener('online', () => this.refresh());
    window.addEventListener('offline', () => this.set({ connected: false }));
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.refresh());

    // Resume the room we were in (e.g. after the phone slept or the page reloaded).
    const code = load(STORAGE.code);
    if (code) this.enter('join_room', { p_code: code, p_key: this.key, p_name: this.state.name });
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ---- RPC plumbing ----------------------------------------------------------

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(error.message || '通信に失敗しました');
    return data as T;
  }

  private fail(e: unknown) {
    const message = e instanceof Error ? e.message : '通信に失敗しました';
    if (this.code && GONE.some((g) => message.includes(g))) this.exitRoom();
    this.set({ error: message });
  }

  /** Applies a fresh view, ignoring responses older than one already applied. */
  private apply(res: RpcResponse) {
    if (!res?.room) return;
    if (res.serverNow < this.lastServerNow) return;
    this.lastServerNow = res.serverNow;
    this.raw = res.room;
    if (this.code !== res.room.code) {
      this.code = res.room.code;
      save(STORAGE.code, res.room.code);
      this.listen(res.room.code, res.room.meId);
    }
    this.publish(res.serverNow - Date.now());
    this.scheduleEventRefresh(res.room, res.serverNow);
  }

  /** Re-derives the visible state: public photo URLs and presence-based online flags. */
  private publish(offset = this.state.offset) {
    const r = this.raw;
    if (!r) return;
    const room: RoomView = {
      ...r,
      players: r.players.map((p) => ({ ...p, connected: this.online ? this.online.has(p.id) : true })),
      photos: r.photos.map((ph) => ({ ...ph, url: supabase.storage.from(PHOTO_BUCKET).getPublicUrl(ph.path).data.publicUrl })),
    };
    this.set({ room, offset, error: null });
  }

  private async enter(fn: 'create_room' | 'join_room', args: Record<string, unknown>) {
    try {
      this.apply(await this.rpc<RpcResponse>(fn, args));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Fetches the caller's view (debounced). */
  refresh = () => {
    if (!this.code) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      if (!this.code) return;
      try {
        this.apply(await this.rpc<RpcResponse>('get_room_view', { p_code: this.code, p_key: this.key }));
        if (navigator.onLine && !this.state.connected && this.channel) this.set({ connected: true });
      } catch (e) {
        this.fail(e);
      }
    }, REFRESH_DEBOUNCE_MS);
  };

  /** Time-based transitions (next selfie mission, game end, capture or sighting expiry) have no ping; refetch at that moment. */
  private scheduleEventRefresh(room: RoomView, serverNow: number) {
    clearTimeout(this.eventTimer);
    if (room.phase !== 'playing') return;
    const times = [room.nextMissionAt, room.endsAt, ...room.captureRequests.map((c) => c.expiresAt), ...room.sightings.map((s) => s.until)]
      .filter((t): t is number => t !== null && t > serverNow);
    if (!times.length) return;
    const wait = Math.min(...times) - serverNow + 300;
    this.eventTimer = setTimeout(() => this.refresh(), Math.min(wait, 2 ** 31 - 1));
  }

  // ---- Realtime --------------------------------------------------------------

  private listen(code: string, meId: string) {
    this.unlisten();
    const channel = supabase.channel(`room:${code}`, { config: { presence: { key: meId } } });
    channel
      .on('broadcast', { event: 'changed' }, () => this.refresh())
      .on('presence', { event: 'sync' }, () => {
        this.online = new Set(Object.keys(channel.presenceState()));
        this.publish();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.track({ at: Date.now() });
          this.set({ connected: true });
          this.refresh(); // catch up on anything missed while (re)connecting
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.set({ connected: false });
        }
      });
    this.channel = channel;
    this.poll = setInterval(this.refresh, POLL_MS);
  }

  private unlisten() {
    clearInterval(this.poll);
    clearTimeout(this.eventTimer);
    clearTimeout(this.refreshTimer);
    if (this.channel) supabase.removeChannel(this.channel);
    this.channel = null;
    this.online = null;
  }

  private exitRoom() {
    this.unlisten();
    this.code = null;
    this.raw = null;
    this.lastServerNow = 0;
    save(STORAGE.code, null);
    this.set({ room: null, connected: navigator.onLine });
  }

  // ---- Public API ------------------------------------------------------------

  setName(name: string) {
    save(STORAGE.name, name);
    this.set({ name });
  }

  create() {
    this.enter('create_room', { p_key: this.key, p_name: this.state.name });
  }

  join(code: string) {
    this.enter('join_room', { p_code: code, p_key: this.key, p_name: this.state.name });
  }

  leave() {
    const code = this.code;
    this.exitRoom();
    if (code) this.rpc('leave_room', { p_code: code, p_key: this.key }).catch(() => {});
  }

  clearError() {
    this.set({ error: null });
  }

  send(msg: ClientMessage) {
    if (msg.type === 'leave') return this.leave();
    const code = this.code;
    if (!code) return;
    const base = { p_code: code, p_key: this.key };
    let call: Promise<unknown>;
    switch (msg.type) {
      case 'location':
        // Fire-and-forget: returns nothing, other players get a Realtime ping.
        call = this.rpc('update_location', { ...base, p_lat: msg.lat, p_lng: msg.lng, p_acc: msg.acc ?? null });
        break;
      case 'setRole':
        call = this.rpc('set_role', { ...base, p_role: msg.role });
        break;
      case 'setSettings':
        call = this.rpc('set_settings', {
          ...base,
          p_team_mode: msg.teamMode ?? null,
          p_center_lat: msg.center?.lat ?? null,
          p_center_lng: msg.center?.lng ?? null,
          p_radius_m: msg.radiusM ?? null,
          p_duration_min: msg.durationMin ?? null,
          p_photo_interval_s: msg.photoIntervalS ?? null,
        });
        break;
      case 'setFootprints':
        call = this.rpc('set_footprints', { ...base, p_delay_s: msg.delayS, p_span_s: msg.spanS });
        break;
      case 'setSpots':
        call = this.rpc('set_spots', { ...base, p_spots: msg.spots });
        break;
      case 'pickupItem':
        call = this.rpc('pickup_item', { ...base, p_spot_id: msg.spotId });
        break;
      case 'useItem':
        call = this.rpc('use_item', { ...base, p_item_id: msg.itemId, p_lat: msg.at?.lat ?? null, p_lng: msg.at?.lng ?? null });
        break;
      case 'setReady':
        call = this.rpc('set_ready', { ...base, p_ready: msg.ready });
        break;
      case 'start':
        call = this.rpc('start_game', base);
        break;
      case 'requestCapture':
        call = this.rpc('request_capture', { ...base, p_runner_id: msg.runnerId });
        break;
      case 'respondCapture':
        call = this.rpc('respond_capture', { ...base, p_request_id: msg.requestId, p_accept: msg.accept });
        break;
    }
    call.then((res) => res && this.apply(res as RpcResponse)).catch((e) => this.fail(e));
  }

  /** Selfie: reserve a one-time slot, upload to Storage, then publish it to the room. */
  async uploadPhoto(mission: number, dataUrl: string, pos: LatLng | null): Promise<void> {
    const code = this.code;
    if (!code) throw new Error('ルームに参加していません');
    const path = await this.rpc<string>('reserve_photo', { p_code: code, p_key: this.key, p_mission: mission });
    const blob = await (await fetch(dataUrl)).blob();
    const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    // A retry after a failed confirm finds the file already there; that's fine.
    if (error && !/exists|duplicate/i.test(error.message)) throw new Error(`写真の送信に失敗しました: ${error.message}`);
    this.apply(await this.rpc<RpcResponse>('confirm_photo', { p_code: code, p_key: this.key, p_path: path, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null }));
  }
}

export const client = new GameClient();

export function useClient(): ClientState {
  return useSyncExternalStore(client.subscribe, () => client.state);
}
