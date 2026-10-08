import { useMemo, useRef, useState } from 'react';
import {
  CHALLENGE_MISSION,
  HEARTBEAT_MS,
  ITEM_INFO,
  POINTS,
  SPOT_RADIUS_M,
  formatClock,
  formatInterval,
  haversineM,
  proximityBand,
  type LatLng,
} from '../../shared/game.ts';
import type { PhotoView, RoomView } from '../../shared/protocol.ts';
import { compressPhoto, useHeartbeat, useNow, useSiren, useWakeLock, type GeoState } from '../device.ts';
import { MapView, escapeHtml, type MapMarker, type MapTrack } from '../MapView.tsx';
import { client } from '../net.ts';

const timeOf = (t: number) => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

export const missionLabel = (mission: number) => (mission === CHALLENGE_MISSION ? '🔥チャレンジ' : `#${mission}`);

export function photoPopup(p: PhotoView): string {
  return `<div class="photo-pop"><img src="${escapeHtml(p.url)}" alt=""/><div>${escapeHtml(p.playerName)} · ${missionLabel(p.mission)} · ${timeOf(p.t)}</div></div>`;
}

export function Game({ room, geo, offset }: { room: RoomView; geo: GeoState; offset: number }) {
  const now = useNow(offset);
  const me = room.players.find((p) => p.id === room.meId)!;
  const isChaser = me.role === 'chaser';
  const runners = room.players.filter((p) => p.role === 'runner');
  const activeRunners = runners.filter((p) => !p.captured);
  const violators = runners.filter((p) => p.violation);
  const myViolation = me.role === 'runner' && me.violation;

  const [muted, setMuted] = useState(false);
  const [sheet, setSheet] = useState<'photos' | 'capture' | 'items' | null>(null);
  /** Item id while the runner is choosing where to drop a decoy. */
  const [placingDecoy, setPlacingDecoy] = useState<string | null>(null);
  /** Which mission the camera is open for (pending mission or the challenge). */
  const shootFor = useRef<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useWakeLock(true);
  useSiren(isChaser && violators.length > 0 && !muted);
  const band = proximityBand(room.proximityM);
  useHeartbeat(band ? HEARTBEAT_MS[band] : null, muted);

  const pendingMission = room.myPendingMissions[0];
  const isActiveRunner = me.role === 'runner' && !me.captured;
  const myPos: LatLng | null = geo.pos ?? me.pos ?? null;
  const distTo = (p: LatLng) => (myPos ? haversineM(myPos, p) : Infinity);
  const nearItem = !me.captured
    ? room.spots.filter((s) => s.kind === 'item' && distTo(s) <= SPOT_RADIUS_M).sort((a, b) => distTo(a) - distTo(b))[0]
    : undefined;
  const challengeSpot = room.spots.find((s) => s.kind === 'challenge');
  const challengeDone = room.photos.some((p) => p.playerId === me.id && p.mission === CHALLENGE_MISSION);
  const nearChallenge = isActiveRunner && !challengeDone && !!challengeSpot && distTo(challengeSpot) <= SPOT_RADIUS_M;

  const openCamera = (mission: number) => {
    shootFor.current = mission;
    setUploadError(null);
    fileInput.current?.click();
  };
  const incomingCapture = room.captureRequests.find((r) => r.runnerId === me.id);
  const myOutgoing = room.captureRequests.filter((r) => r.chaserId === me.id);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    for (const p of room.players) {
      if (!p.pos || p.id === me.id || p.captured) continue;
      if (p.role === me.role) out.push({ id: p.id, pos: p.pos, kind: 'teammate', label: p.name });
      else if (p.violation) out.push({ id: p.id, pos: p.pos, kind: 'alert', label: `${p.name} エリア外!` });
    }
    if (isChaser) {
      for (const ph of room.photos) {
        if (ph.pos) out.push({ id: ph.id, pos: ph.pos, kind: 'photo', label: missionLabel(ph.mission), popupHtml: photoPopup(ph) });
      }
    }
    // Footprint radar: the newest delayed point gets a 👣 pin with how old it is.
    for (const [id, pts] of Object.entries(room.footprints)) {
      const last = pts[pts.length - 1];
      if (!last) continue;
      const who = id === me.id ? '自分' : (room.players.find((p) => p.id === id)?.name ?? '逃走者');
      const minsAgo = Math.max(1, Math.round((now - last[2]) / 60_000));
      out.push({ id: `fp-${id}`, pos: { lat: last[0], lng: last[1] }, kind: 'footprint', label: `${who} ${minsAgo}分前` });
    }
    for (const s of room.spots) {
      if (s.kind === 'item') out.push({ id: s.id, pos: s, kind: 'item', label: s.name || 'アイテム' });
      else out.push({ id: s.id, pos: s, kind: 'challenge', label: `🔥チャレンジ ${s.name}`.trim() });
    }
    for (const s of room.sightings) {
      out.push({ id: s.id, pos: s, kind: 'sighting', label: s.mine ? '偽の足跡（あなた）' : `${s.name} 目撃情報` });
    }
    const here = geo.pos ?? me.pos;
    if (here) out.push({ id: 'me', pos: here, kind: 'me' });
    return out;
    // `now` only matters for the "n分前" label; recompute at most every 30 s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.players, room.photos, room.footprints, room.spots, room.sightings, me.id, me.role, me.pos, isChaser, geo.pos, Math.floor(now / 30_000)]);

  const footprintTracks = useMemo<MapTrack[]>(
    () => Object.entries(room.footprints).map(([id, pts]) => ({
      id: `fp-${id}`,
      color: '#ff5a5a',
      faint: true,
      points: pts.map(([lat, lng]) => ({ lat, lng })),
    })),
    [room.footprints],
  );

  const area = useMemo(
    () => (room.settings.center ? { center: room.settings.center, radiusM: room.settings.radiusM } : null),
    [room.settings.center, room.settings.radiusM],
  );

  const takePhoto = async (file: File | undefined) => {
    const mission = shootFor.current ?? pendingMission;
    if (!file || mission === undefined) return;
    setUploading(true);
    setUploadError(null);
    try {
      const dataUrl = await compressPhoto(file);
      await client.uploadPhoto(mission, dataUrl, geo.pos ? { lat: geo.pos.lat, lng: geo.pos.lng } : null);
      shootFor.current = null;
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : '送信に失敗しました');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className={`screen game ${violators.length && isChaser ? 'alarm' : ''}`}>
      <div className="statusbar">
        <div>
          <small>残り時間</small>
          <b className="mono">{formatClock((room.endsAt ?? now) - now)}</b>
        </div>
        <div>
          <small>Next Photo{room.settings.photoIntervalS < 600 && <span className="demo-label"> · DEMO {formatInterval(room.settings.photoIntervalS)}</span>}</small>
          <b className="mono">{room.nextMissionAt ? formatClock(room.nextMissionAt - now) : '--:--'}</b>
        </div>
        <div>
          <small>逃走者</small>
          <b>{activeRunners.length} / {runners.length}</b>
        </div>
      </div>

      <div className={`role-banner ${me.role}`}>
        あなたは<b>{isChaser ? '追跡者' : '逃走者'}</b>
        {me.captured && ' — 確保されました（観戦中）'}
        <button className="btn ghost small" onClick={() => setMuted((m) => !m)}>{muted ? '🔇 音オフ' : '🔊 音オン'}</button>
      </div>

      {band && (
        <div className={`proximity-banner b${band}`} style={{ ['--beat' as string]: `${HEARTBEAT_MS[band]}ms` }}>
          <span className="heart">💓</span>
          {band}m以内に{isChaser ? '逃走者' : '追跡者'}がいる…！
        </div>
      )}

      {isChaser && violators.length > 0 && (
        <div className="alert-banner">🚨 エリア外: {violators.map((v) => v.name).join('、')} の現在地を公開中</div>
      )}
      {myViolation && <div className="alert-banner">⚠️ エリア外です！追跡者に現在地が公開されています。すぐに戻ってください</div>}
      {geo.error && <div className="warn-banner">{geo.error}</div>}
      {placingDecoy && (
        <div className="place-banner">
          👣 地図をタップして偽の足跡を置く場所を選んでください
          <button className="btn ghost small" onClick={() => setPlacingDecoy(null)}>やめる</button>
        </div>
      )}
      {isActiveRunner && room.mySkippedMissions.length > 0 && (
        <div className="info-banner">🫥 透明化: 自撮りミッション {room.mySkippedMissions.map((m) => `#${m}`).join('・')} はスキップされます</div>
      )}

      <MapView
        className="game-map"
        area={area}
        markers={markers}
        tracks={footprintTracks}
        fitKey="game"
        initialCenter={room.settings.center}
        onTap={placingDecoy ? (at) => {
          client.send({ type: 'useItem', itemId: placingDecoy, at });
          setPlacingDecoy(null);
        } : undefined}
      />
      {room.settings.footprintSpanS > 0 && (
        <div className="footprint-note">
          👣 足跡レーダー: 逃走者の{Math.round(room.settings.footprintDelayS / 60)}〜
          {Math.round((room.settings.footprintDelayS + room.settings.footprintSpanS) / 60)}分前の移動
          {isChaser ? 'を表示中' : 'が追跡者に見えています'}
        </div>
      )}

      {(nearItem || nearChallenge) && (
        <div className="context-actions">
          {nearItem && (
            <button className="btn primary pulse" onClick={() => client.send({ type: 'pickupItem', spotId: nearItem.id })}>
              🎁 アイテムを拾う{nearItem.name && `（${nearItem.name}）`}
            </button>
          )}
          {nearChallenge && (
            <button className="btn danger pulse" onClick={() => openCamera(CHALLENGE_MISSION)}>
              🔥 チャレンジ自撮り（逃げ切り×{POINTS.challengeMultiplier}）
            </button>
          )}
        </div>
      )}

      <div className="actions">
        {isActiveRunner && (
          <button className={`btn ${pendingMission ? 'primary pulse' : 'secondary'}`} disabled={!pendingMission} onClick={() => openCamera(pendingMission)}>
            📸 自撮り
          </button>
        )}
        <button className="btn secondary" onClick={() => setSheet('photos')}>
          🖼 写真 ({room.photos.length})
        </button>
        {!me.captured && (
          <button className={`btn ${room.myItems.length ? 'primary' : 'secondary'}`} onClick={() => setSheet('items')}>
            🎒 アイテム ({room.myItems.length})
          </button>
        )}
        {isChaser && (
          <button className="btn danger" onClick={() => setSheet('capture')}>
            🤝 確保
          </button>
        )}
      </div>

      <input ref={fileInput} type="file" accept="image/*" capture="user" hidden onChange={(e) => takePhoto(e.target.files?.[0])} />

      {/* Forced selfie mission popup. */}
      {pendingMission && !me.captured && (
        <div className="modal-backdrop">
          <div className="modal mission">
            <div className="mission-icon">📸</div>
            <h2>自撮りミッション #{pendingMission}</h2>
            <p>自分の<b>顔</b>と<b>背景</b>がはっきり写るように撮影して送信してください。写真と撮影場所は追跡者全員に共有されます。</p>
            {uploadError && <p className="warn">{uploadError}</p>}
            <button className="btn primary big" disabled={uploading} onClick={() => openCamera(pendingMission)}>
              {uploading ? '送信中…' : 'カメラを起動'}
            </button>
          </div>
        </div>
      )}

      {incomingCapture && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>確保されましたか？</h2>
            <p>
              <b>{room.players.find((p) => p.id === incomingCapture.chaserId)?.name}</b> があなたを確保したと申請しています。
              {incomingCapture.distanceM !== null && <><br /><small className="muted">GPS上の距離: 約{incomingCapture.distanceM}m</small></>}
            </p>
            <div className="row">
              <button className="btn secondary grow" onClick={() => client.send({ type: 'respondCapture', requestId: incomingCapture.id, accept: false })}>
                まだ捕まってない
              </button>
              <button className="btn danger grow" onClick={() => client.send({ type: 'respondCapture', requestId: incomingCapture.id, accept: true })}>
                確保を認める
              </button>
            </div>
          </div>
        </div>
      )}

      {sheet === 'photos' && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>ヒント写真ログ</h3>
            {room.photos.length === 0 && <p className="muted">まだ写真はありません。最初の写真は開始{formatInterval(room.settings.photoIntervalS)}後です。</p>}
            <div className="gallery">
              {[...room.photos].reverse().map((ph) => (
                <figure key={ph.id}>
                  <a href={ph.url} target="_blank" rel="noreferrer"><img src={ph.url} alt="" loading="lazy" /></a>
                  <figcaption>
                    {ph.playerName} · {missionLabel(ph.mission)} · {timeOf(ph.t)}
                    {ph.pos && geo.pos && <> · 約{(haversineM(ph.pos, geo.pos) / 1000).toFixed(1)}km先</>}
                  </figcaption>
                </figure>
              ))}
            </div>
            <button className="btn secondary" onClick={() => setSheet(null)}>閉じる</button>
          </div>
        </div>
      )}

      {sheet === 'items' && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>🎒 アイテム</h3>
            {room.myItems.length === 0 && (
              <p className="muted">
                まだありません。地図の🎁に{SPOT_RADIUS_M}m以内まで近づくと拾えます。
                {isChaser ? '追跡者は📡レーダー、' : '逃走者は🫥透明化か👣偽の足跡、'}どちらかが手に入ります。
              </p>
            )}
            <ul className="item-list">
              {room.myItems.map((it) => (
                <li key={it.id}>
                  <span className="item-icon">{ITEM_INFO[it.type].icon}</span>
                  <span className="grow">
                    <b>{ITEM_INFO[it.type].name}</b>
                    <small className="muted">{ITEM_INFO[it.type].desc}</small>
                  </span>
                  <button
                    className="btn primary small"
                    onClick={() => {
                      setSheet(null);
                      if (it.type === 'decoy') setPlacingDecoy(it.id);
                      else client.send({ type: 'useItem', itemId: it.id });
                    }}
                  >
                    使う
                  </button>
                </li>
              ))}
            </ul>
            {challengeSpot && me.role === 'runner' && (
              <p className="muted small">
                🔥 チャレンジ: 「{challengeSpot.name || 'チャレンジ地点'}」の{SPOT_RADIUS_M}m以内で自撮りすると、逃げ切りボーナスが×{POINTS.challengeMultiplier}。
                ただし写真と場所は追跡者に共有されます。{challengeDone && '（達成済み ✅）'}
              </p>
            )}
            <button className="btn secondary" onClick={() => setSheet(null)}>閉じる</button>
          </div>
        </div>
      )}

      {sheet === 'capture' && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>誰を確保しましたか？</h3>
            <p className="muted small">逃走者の端末で承認されると確保成立です。</p>
            <ul className="capture-list">
              {runners.map((r) => {
                const waiting = myOutgoing.some((o) => o.runnerId === r.id);
                return (
                  <li key={r.id}>
                    <span>{r.name}</span>
                    {r.captured ? (
                      <span className="muted">確保済み</span>
                    ) : (
                      <button className="btn danger small" disabled={waiting} onClick={() => client.send({ type: 'requestCapture', runnerId: r.id })}>
                        {waiting ? '承認待ち…' : '確保'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <button className="btn secondary" onClick={() => setSheet(null)}>閉じる</button>
          </div>
        </div>
      )}
    </div>
  );
}
