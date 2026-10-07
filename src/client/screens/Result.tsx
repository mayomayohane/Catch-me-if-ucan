import { useEffect, useMemo, useState } from 'react';
import { formatClock, type LatLng } from '../../shared/game.ts';
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

/** Track points recorded up to time t. */
function upTo(track: TrackPoint[], t: number): LatLng[] {
  return track.filter((p) => p[2] <= t).map(([lat, lng]) => ({ lat, lng }));
}

export function Result({ room }: { room: RoomView }) {
  const result = room.result!;
  const start = room.startedAt ?? result.endedAt;
  const span = Math.max(1, result.endedAt - start);
  const [t, setT] = useState(span);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((cur) => {
        const next = cur + span / 200; // whole game in ~10s
        if (next >= span) {
          setPlaying(false);
          return span;
        }
        return next;
      });
    }, 50);
    return () => clearInterval(id);
  }, [playing, span]);

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
      const pts = upTo(result.tracks[p.id] ?? [], abs);
      tracks.push({ id: p.id, color: colors[p.id], points: pts });
      const last = pts[pts.length - 1];
      if (last) markers.push({ id: p.id, pos: last, kind: p.role === 'runner' ? 'runner' : 'chaser', label: p.name });
    }
    for (const ph of room.photos) {
      if (ph.pos && ph.t <= abs) markers.push({ id: ph.id, pos: ph.pos, kind: 'photo', label: `#${ph.mission}`, popupHtml: photoPopup(ph) });
    }
    return { tracks, markers };
  }, [t, start, room.players, room.photos, result.tracks, colors]);

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
          <input className="grow" type="range" min={0} max={span} value={t} onChange={(e) => (setPlaying(false), setT(Number(e.target.value)))} />
          <span className="mono small">{formatClock(t)}</span>
        </div>
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
