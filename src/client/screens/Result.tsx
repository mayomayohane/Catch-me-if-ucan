import { useEffect, useMemo, useState } from 'react';
import { formatClock, nearMisses, positionAt, type LatLng, type NearMiss } from '../../shared/game.ts';
import type { RoomView, TrackPoint } from '../../shared/protocol.ts';
import { MapView, type MapMarker, type MapTrack } from '../MapView.tsx';
import { client } from '../net.ts';
import { photoPopup } from './Game.tsx';

const RUNNER_COLORS = ['#ff3b3b', '#ff9f1c', '#ff5fa2'];
const CHASER_COLORS = ['#2f80ff', '#00c2d1', '#7b61ff', '#2ecc71'];

const REASON: Record<string, string> = {
  all_captured: '逃走者を全員確保！',
  time_up: '制限時間まで逃げ切った！',
  no_runners: '逃走者がいなくなりました',
};

/** Replay speeds (× real time). */
const SPEEDS = [30, 60, 120] as const;
const TICK_MS = 50;
/** Start a near-miss replay this long before the closest moment. */
const NEAR_MISS_LEAD_MS = 20_000;

/** Track up to time t, ending exactly at the interpolated position so the line meets the marker. */
function upTo(track: TrackPoint[], t: number): LatLng[] {
  const pts = track.filter((p) => p[2] <= t).map(([lat, lng]) => ({ lat, lng }));
  const here = positionAt(track, t);
  if (here && pts.length) pts.push(here);
  return pts;
}

export function Result({ room }: { room: RoomView }) {
  const result = room.result!;
  const start = room.startedAt ?? result.endedAt;
  const span = Math.max(1, result.endedAt - start);
  const [t, setT] = useState(span);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(60);
  const [focusMiss, setFocusMiss] = useState<NearMiss | null>(null);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((cur) => {
        const next = cur + TICK_MS * speed;
        if (next >= span) {
          setPlaying(false);
          return span;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, span, speed]);

  // "スレスレ" moments: closest runner–chaser encounters, auto-detected from the tracks.
  const misses = useMemo(() => {
    const pick = (role: 'runner' | 'chaser') =>
      room.players.filter((p) => p.role === role).map((p) => ({ id: p.id, track: result.tracks[p.id] ?? [] }));
    return nearMisses(pick('runner'), pick('chaser'));
  }, [room.players, result.tracks]);
  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '?';

  const playMiss = (m: NearMiss) => {
    setFocusMiss(m);
    setT(Math.max(0, m.t - start - NEAR_MISS_LEAD_MS));
    setSpeed(30);
    setPlaying(true);
  };

  const colors = useMemo(() => {
    const map: Record<string, string> = {};
    let r = 0;
    let c = 0;
    for (const p of room.players) {
      map[p.id] = p.role === 'runner' ? RUNNER_COLORS[r++ % RUNNER_COLORS.length] : CHASER_COLORS[c++ % CHASER_COLORS.length];
    }
    return map;
  }, [room.players]);

  const { tracks, markers } = useMemo(() => {
    const abs = start + t;
    const tracks: MapTrack[] = [];
    const markers: MapMarker[] = [];
    for (const p of room.players) {
      const track = result.tracks[p.id] ?? [];
      tracks.push({ id: p.id, color: colors[p.id], points: upTo(track, abs) });
      const here = positionAt(track, abs);
      if (here) markers.push({ id: p.id, pos: here, kind: p.role === 'runner' ? 'runner' : 'chaser', label: p.name });
    }
    // Mark the near-miss spot once the replay reaches it.
    if (focusMiss && abs >= focusMiss.t - 1000) {
      const here = positionAt(result.tracks[focusMiss.runnerId] ?? [], focusMiss.t);
      if (here) markers.push({ id: 'nearmiss', pos: here, kind: 'nearmiss', label: `${focusMiss.distanceM}m!` });
    }
    for (const ph of room.photos) {
      if (ph.pos && ph.t <= abs) markers.push({ id: ph.id, pos: ph.pos, kind: 'photo', label: `#${ph.mission}`, popupHtml: photoPopup(ph) });
    }
    return { tracks, markers };
  }, [t, start, room.players, room.photos, result.tracks, colors, focusMiss]);

  const area = useMemo(
    () => (room.settings.center ? { center: room.settings.center, radiusM: room.settings.radiusM } : null),
    [room.settings.center, room.settings.radiusM],
  );

  return (
    <div className="screen result">
      <div className={`winner ${result.winner}`}>
        <small>{REASON[result.reason]}</small>
        <h1>{result.winner === 'runner' ? '逃走者勝利！' : '追跡者勝利！'}</h1>
      </div>

      <section className="card">
        <h3>プレイバック</h3>
        <MapView className="result-map" area={area} markers={markers} tracks={tracks} fitKey="result" initialCenter={room.settings.center} />
        <div className="row playback">
          <button
            className="btn secondary small"
            onClick={() => {
              if (!playing && t >= span) setT(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <input className="grow" type="range" min={0} max={span} value={t} onChange={(e) => (setPlaying(false), setFocusMiss(null), setT(Number(e.target.value)))} />
          <span className="mono small">{formatClock(t)}</span>
        </div>
        <div className="row playback">
          <span className="muted small">再生速度</span>
          <div className="speed">
            {SPEEDS.map((s) => (
              <button key={s} className={s === speed ? 'on' : ''} onClick={() => setSpeed(s)}>×{s}</button>
            ))}
          </div>
        </div>
        {misses.length > 0 && (
          <>
            <h3>⚡ ニアミス</h3>
            <ul className="nearmiss-list">
              {misses.map((m) => (
                <li key={`${m.runnerId}-${m.chaserId}-${m.t}`}>
                  <button className={focusMiss === m ? 'on' : ''} onClick={() => playMiss(m)}>
                    <span className="mono">{formatClock(m.t - start)}</span>
                    <span>{nameOf(m.runnerId)} × {nameOf(m.chaserId)}</span>
                    <span className="dist">{m.distanceM}m</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <ul className="legend">
          {room.players.map((p) => (
            <li key={p.id}>
              <i style={{ background: colors[p.id] }} />
              {p.name}（{p.role === 'runner' ? `逃走者${p.captured ? '・確保' : ''}` : '追跡者'}）
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>自撮りハイライト</h3>
        {room.photos.length === 0 && <p className="muted">写真はありません</p>}
        <div className="gallery">
          {room.photos.map((ph) => (
            <figure key={ph.id}>
              <a href={ph.url} target="_blank" rel="noreferrer"><img src={ph.url} alt="" loading="lazy" /></a>
              <figcaption>{ph.playerName} · #{ph.mission}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <div className="sticky-actions">
        <button className="btn primary big" onClick={() => client.leave()}>ホームに戻る</button>
      </div>
    </div>
  );
}
