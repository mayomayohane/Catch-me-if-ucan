import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DURATIONS,
  MAX_RADIUS_M,
  MIN_RADIUS_M,
  PHOTO_INTERVALS_S,
  formatInterval,
  TEAM_MODES,
  roleCount,
  startBlockers,
  type LatLng,
  type Role,
  type TeamMode,
} from '../../shared/game.ts';
import type { RoomView } from '../../shared/protocol.ts';
import { unlockAudio, type GeoState } from '../device.ts';
import { MapView, type MapMarker } from '../MapView.tsx';
import { client } from '../net.ts';

const ROLE_LABEL: Record<Role, string> = { runner: '逃走者', chaser: '追跡者' };

interface SearchResult {
  name: string;
  pos: LatLng;
}

async function searchPlace(q: string): Promise<SearchResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ja&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
  return rows.map((r) => ({ name: r.display_name, pos: { lat: Number(r.lat), lng: Number(r.lon) } }));
}

export function Lobby({ room, geo }: { room: RoomView; geo: GeoState }) {
  const me = room.players.find((p) => p.id === room.meId)!;
  const isHost = me.isHost;
  const { settings } = room;
  const mode = TEAM_MODES[settings.teamMode];
  const blockers = startBlockers(room.players, settings);

  // Radius slider: local value while dragging, synced to the server after a short pause.
  const [radius, setRadius] = useState(settings.radiusM);
  const radiusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setRadius(settings.radiusM), [settings.radiusM]);
  const onRadius = (v: number) => {
    setRadius(v);
    clearTimeout(radiusTimer.current);
    radiusTimer.current = setTimeout(() => client.send({ type: 'setSettings', radiusM: v }), 250);
  };

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [focus, setFocus] = useState<{ pos: LatLng; seq: number } | null>(null);
  const flyTo = (pos: LatLng) => setFocus((f) => ({ pos, seq: (f?.seq ?? 0) + 1 }));

  const setCenter = (pos: LatLng) => client.send({ type: 'setSettings', center: pos });

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (settings.center) out.push({ id: 'center', pos: settings.center, kind: 'center' });
    if (geo.pos) out.push({ id: 'me', pos: geo.pos, kind: 'me' });
    return out;
  }, [settings.center, geo.pos]);

  const area = useMemo(
    () => (settings.center ? { center: settings.center, radiusM: radius } : null),
    [settings.center, radius],
  );

  const copyCode = () => {
    const text = `「リアル探してください」で遊ぼう！ルームコード: ${room.code}`;
    if (navigator.share) navigator.share({ text, url: location.origin }).catch(() => {});
    else navigator.clipboard?.writeText(room.code);
  };

  return (
    <div className="screen lobby">
      <div className="lobby-head">
        <button className="btn ghost small" onClick={() => client.leave()}>← 退出</button>
        <button className="room-code" onClick={copyCode} title="共有">
          <span className="muted small">ルームコード</span>
          <strong>{room.code}</strong>
        </button>
      </div>

      <section className="card">
        <h3>チーム構成</h3>
        <div className="segmented">
          {(Object.keys(TEAM_MODES) as TeamMode[]).map((m) => (
            <button
              key={m}
              className={m === settings.teamMode ? 'on' : ''}
              disabled={!isHost}
              onClick={() => client.send({ type: 'setSettings', teamMode: m })}
            >
              <b>{TEAM_MODES[m].label}</b>
              <small>{TEAM_MODES[m].desc}</small>
            </button>
          ))}
        </div>

        <h3>あなたの役割</h3>
        <div className="role-toggle">
          {(['runner', 'chaser'] as Role[]).map((r) => {
            const count = roleCount(room.players, r);
            const cap = mode[r];
            const mine = me.role === r;
            const locked = !mine && count >= cap;
            return (
              <button
                key={r}
                className={`role ${r} ${mine ? 'on' : ''}`}
                disabled={locked}
                onClick={() => client.send({ type: 'setRole', role: mine ? null : r })}
              >
                <span>{ROLE_LABEL[r]}</span>
                <small>{locked ? '🔒 定員' : `${count} / ${cap}`}</small>
              </button>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h3>プレイヤー（{room.players.length} / 5）</h3>
        <ul className="players">
          {room.players.map((p) => (
            <li key={p.id} className={p.connected ? '' : 'offline'}>
              <span className="name">
                {p.name}
                {p.isHost && <em className="tag">ホスト</em>}
                {p.id === room.meId && <em className="tag me">あなた</em>}
              </span>
              <span className={`role-chip ${p.role ?? 'none'}`}>{p.role ? ROLE_LABEL[p.role] : '未選択'}</span>
              <span className={p.ready ? 'ready' : 'not-ready'}>{p.ready ? '準備OK' : '…'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>エリア設定 {isHost ? <small className="muted">地図をタップして中心ピンを設置</small> : null}</h3>
        {isHost && (
          <form
            className="search"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!query.trim()) return;
              setResults(await searchPlace(query).catch(() => []));
            }}
          >
            <input value={query} placeholder="場所を検索（例: 渋谷駅）" onChange={(e) => setQuery(e.target.value)} />
            <button className="btn secondary small" type="submit">検索</button>
            <button
              className="btn secondary small"
              type="button"
              disabled={!geo.pos}
              onClick={() => geo.pos && (flyTo(geo.pos), setCenter(geo.pos))}
              title="現在地を中心にする"
            >
              ◎ 現在地
            </button>
          </form>
        )}
        {results && (
          <ul className="search-results">
            {results.length === 0 && <li className="muted">見つかりませんでした</li>}
            {results.map((r) => (
              <li key={r.name}>
                <button onClick={() => (flyTo(r.pos), setCenter(r.pos), setResults(null))}>{r.name}</button>
              </li>
            ))}
          </ul>
        )}
        <MapView
          className="lobby-map"
          area={area}
          markers={markers}
          onTap={isHost ? setCenter : undefined}
          initialCenter={settings.center ?? geo.pos}
          focus={focus}
        />
        {!settings.center && <p className="muted small">{isHost ? '中心ピンを設定してください' : 'ホストがエリアを設定中です'}</p>}

        <div className="row">
          <label className="grow">
            <span>半径: <b>{(radius / 1000).toFixed(1)} km</b></span>
            <input
              type="range"
              min={MIN_RADIUS_M}
              max={MAX_RADIUS_M}
              step={100}
              value={radius}
              disabled={!isHost}
              onChange={(e) => onRadius(Number(e.target.value))}
            />
          </label>
        </div>

        <h3>ゲーム時間</h3>
        <div className="segmented">
          {DURATIONS.map((d) => (
            <button
              key={d}
              className={d === settings.durationMin ? 'on' : ''}
              disabled={!isHost}
              onClick={() => client.send({ type: 'setSettings', durationMin: d })}
            >
              <b>{d}分</b>
            </button>
          ))}
        </div>

        <h3>自撮り間隔 {settings.photoIntervalS < 600 && <em className="tag demo">デモモード</em>}</h3>
        <div className="segmented">
          {PHOTO_INTERVALS_S.map((s) => (
            <button
              key={s}
              className={s === settings.photoIntervalS ? 'on' : ''}
              disabled={!isHost}
              onClick={() => client.send({ type: 'setSettings', photoIntervalS: s })}
            >
              <b>{formatInterval(s)}</b>
              <small>{s === 600 ? '通常' : 'デモ・お試し用'}</small>
            </button>
          ))}
        </div>
      </section>

      {geo.error && <p className="warn">{geo.error}</p>}

      <div className="sticky-actions">
        <button
          className={`btn big ${me.ready ? 'secondary' : 'primary'}`}
          disabled={!me.role}
          onClick={() => {
            unlockAudio();
            client.send({ type: 'setReady', ready: !me.ready });
          }}
        >
          {me.ready ? '準備完了を取り消す' : me.role ? '準備完了' : '役割を選んでください'}
        </button>
        {isHost && (
          <>
            <button
              className="btn danger big"
              disabled={blockers.length > 0}
              onClick={() => {
                unlockAudio();
                client.send({ type: 'start' });
              }}
            >
              ゲームスタート
            </button>
            {blockers.length > 0 && <p className="muted small center">{blockers.join(' / ')}</p>}
          </>
        )}
      </div>
    </div>
  );
}
