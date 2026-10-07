import { useSyncExternalStore } from 'react';
import type { ClientMessage, PhotoUploadRequest, PhotoView, RoomView, ServerMessage } from '../shared/protocol.ts';

const STORAGE = { key: 'cmiu.key', name: 'cmiu.name', code: 'cmiu.code' };

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
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private retry = 0;
  state: ClientState;

  constructor() {
    let key = load(STORAGE.key);
    if (!key) {
      key = makeKey();
      save(STORAGE.key, key);
    }
    this.key = key;
    this.state = { connected: false, room: null, offset: 0, error: null, name: load(STORAGE.name) ?? '' };
    this.connect();
  }

  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ connected: true });
      // Resume the room we were in (e.g. after the phone slept or the page reloaded).
      const code = load(STORAGE.code);
      if (code) this.raw({ type: 'join', key: this.key, name: this.state.name, code });
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMessage);
    ws.onclose = () => {
      this.ws = null;
      this.set({ connected: false });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'state':
        save(STORAGE.code, msg.room.code);
        this.set({ room: msg.room, offset: msg.serverNow - Date.now(), error: null });
        break;
      case 'left':
        save(STORAGE.code, null);
        this.set({ room: null });
        break;
      case 'error':
        // A stale saved room (expired or full) should not keep us stuck.
        if (!this.state.room) save(STORAGE.code, null);
        this.set({ error: msg.message });
        break;
    }
  }

  private raw(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.set({ error: 'サーバーに接続中です…' });
  }

  send(msg: Exclude<ClientMessage, { type: 'create' | 'join' }>) {
    this.raw(msg);
  }

  setName(name: string) {
    save(STORAGE.name, name);
    this.set({ name });
  }

  create() {
    this.raw({ type: 'create', key: this.key, name: this.state.name });
  }

  join(code: string) {
    this.raw({ type: 'join', key: this.key, name: this.state.name, code });
  }

  leave() {
    save(STORAGE.code, null);
    this.raw({ type: 'leave' });
    this.set({ room: null });
  }

  clearError() {
    this.set({ error: null });
  }

  async uploadPhoto(mission: number, dataUrl: string, pos: PhotoUploadRequest['pos']): Promise<PhotoView> {
    const room = this.state.room;
    if (!room) throw new Error('ルームに参加していません');
    const body: PhotoUploadRequest = { code: room.code, key: this.key, mission, dataUrl, pos };
    const res = await fetch('/api/photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? '送信に失敗しました');
    return json.photo;
  }
}

export const client = new GameClient();

export function useClient(): ClientState {
  return useSyncExternalStore(client.subscribe, () => client.state);
}
