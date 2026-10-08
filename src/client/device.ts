import { useEffect, useRef, useState } from 'react';
import { haversineM, type LatLng } from '../shared/game.ts';
import { client } from './net.ts';

export interface GeoState {
  pos: (LatLng & { acc: number }) | null;
  error: string | null;
}

const SEND_MIN_INTERVAL_MS = 3000;
const HEARTBEAT_MS = 15000;

/**
 * Watches GPS and streams it to the server while in a room.
 * Note: browsers pause this when the page is hidden; a native wrapper is needed for true background tracking.
 */
export function useGeolocation(share: boolean): GeoState {
  const [state, setState] = useState<GeoState>({ pos: null, error: null });
  const lastSent = useRef<{ pos: LatLng; t: number } | null>(null);
  const shareRef = useRef(share);
  shareRef.current = share;

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setState({ pos: null, error: 'この端末は位置情報に対応していません' });
      return;
    }
    let latest: (LatLng & { acc: number }) | null = null;
    let trailing: ReturnType<typeof setTimeout> | undefined;

    const sendLatest = () => {
      if (!latest || !shareRef.current) return;
      lastSent.current = { pos: latest, t: Date.now() };
      client.send({ type: 'location', lat: latest.lat, lng: latest.lng, acc: latest.acc });
    };

    // Sends immediately when allowed; otherwise schedules a trailing send so the last
    // position is never dropped (e.g. a runner steps back into the area and stops moving).
    const maybeSend = () => {
      const prev = lastSent.current;
      const now = Date.now();
      if (!prev || now - prev.t >= SEND_MIN_INTERVAL_MS) {
        clearTimeout(trailing);
        trailing = undefined;
        sendLatest();
      } else if (!trailing && latest && haversineM(prev.pos, latest) >= 1) {
        trailing = setTimeout(() => {
          trailing = undefined;
          sendLatest();
        }, SEND_MIN_INTERVAL_MS - (now - prev.t));
      }
    };

    const id = navigator.geolocation.watchPosition(
      (p) => {
        latest = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        setState({ pos: latest, error: null });
        maybeSend();
      },
      (err) => setState((s) => ({ ...s, error: err.code === err.PERMISSION_DENIED ? '位置情報の利用を許可してください' : '現在地を取得できません' })),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    const heartbeat = setInterval(sendLatest, HEARTBEAT_MS);
    return () => {
      navigator.geolocation.clearWatch(id);
      clearInterval(heartbeat);
      clearTimeout(trailing);
    };
  }, []);

  // Push the current position as soon as sharing starts (e.g. right after joining a room).
  useEffect(() => {
    if (share && state.pos) {
      lastSent.current = { pos: state.pos, t: Date.now() };
      client.send({ type: 'location', lat: state.pos.lat, lng: state.pos.lng, acc: state.pos.acc });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share]);

  return state;
}

/** Keeps the screen on during the game so GPS keeps updating. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
        if (cancelled) lock.release();
      } catch {
        /* denied or unsupported */
      }
    };
    const onVisible = () => document.visibilityState === 'visible' && acquire();
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release();
    };
  }, [active]);
}

/** Server-synchronised clock that re-renders every `ms`. */
export function useNow(offset: number, ms = 250): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + offset), ms);
    return () => clearInterval(id);
  }, [offset, ms]);
  return now;
}

// ---- Siren -----------------------------------------------------------------

let audio: AudioContext | null = null;

/** Must be called from a user gesture once, so the alarm can play later. */
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    /* no Web Audio */
  }
}

/** Plays a wailing siren while `on` is true. */
export function useSiren(on: boolean) {
  useEffect(() => {
    if (!on) return;
    unlockAudio();
    if (!audio) return;
    const ctx = audio;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    // Sweep 600Hz <-> 1400Hz every second.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 1;
    lfoGain.gain.value = 400;
    osc.frequency.value = 1000;
    lfo.connect(lfoGain).connect(osc.frequency);
    osc.start();
    lfo.start();
    const vib = setInterval(() => navigator.vibrate?.([400, 200, 400]), 1500);
    return () => {
      clearInterval(vib);
      osc.stop();
      lfo.stop();
      osc.disconnect();
      lfo.disconnect();
    };
  }, [on]);
}

// ---- Photos ----------------------------------------------------------------

/** Downscales a camera photo to a JPEG data URL suitable for upload. */
export async function compressPhoto(file: File, maxSide = 1024, quality = 0.75): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
}

// ---- Heartbeat (proximity alert) -------------------------------------------

/** One "ドックン": a strong low thump followed by a softer one. */
function thump(ctx: AudioContext, at: number, gainPeak: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(70, at);
  osc.frequency.exponentialRampToValueAtTime(40, at + 0.12);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(gainPeak, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.16);
}

/**
 * Plays a heartbeat while an opponent is within `periodMs`'s band; faster when closer.
 * Vibrates where supported (Android). iPhone browsers cannot vibrate, so sound carries it there.
 */
export function useHeartbeat(periodMs: number | null, muted: boolean) {
  useEffect(() => {
    if (!periodMs) return;
    const beat = () => {
      navigator.vibrate?.([70, 110, 50]);
      if (muted || !audio) return;
      const t = audio.currentTime + 0.01;
      thump(audio, t, 0.9);
      thump(audio, t + 0.18, 0.5);
    };
    unlockAudio();
    beat();
    const id = setInterval(beat, periodMs);
    return () => clearInterval(id);
  }, [periodMs, muted]);
}
