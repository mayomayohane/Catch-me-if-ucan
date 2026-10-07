import { useMemo, useRef, useState } from 'react';
import { formatClock, haversineM } from '../../shared/game.ts';
import type { PhotoView, RoomView } from '../../shared/protocol.ts';
import { compressPhoto, useNow, useSiren, useWakeLock, type GeoState } from '../device.ts';
import { MapView, escapeHtml, type MapMarker } from '../MapView.tsx';
import { client } from '../net.ts';

const timeOf = (t: number) => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

export function photoPopup(p: PhotoView): string {
  return `<div class="photo-pop"><img src="${escapeHtml(p.url)}" alt=""/><div>${escapeHtml(p.playerName)} · ミッション${p.mission} · ${timeOf(p.t)}</div></div>`;
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
  const [sheet, setSheet] = useState<'photos' | 'capture' | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useWakeLock(true);
  useSiren(isChaser && violators.length > 0 && !muted);

  const pendingMission = room.myPendingMissions[0];
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
        if (ph.pos) out.push({ id: ph.id, pos: ph.pos, kind: 'photo', label: `#${ph.mission}`, popupHtml: photoPopup(ph) });
      }
    }
    const myPos = geo.pos ?? me.pos;
    if (myPos) out.push({ id: 'me', pos: myPos, kind: 'me' });
    return out;
  }, [room.players, room.photos, me.id, me.role, me.pos, isChaser, geo.pos]);

  const area = useMemo(
    () => (room.settings.center ? { center: room.settings.center, radiusM: room.settings.radiusM } : null),
    [room.settings.center, room.settings.radiusM],
  );

  const takePhoto = async (file: File | undefined) => {
    if (!file || !pendingMission) return;
    setUploading(true);
    setUploadError(null);
    try {
      const dataUrl = await compressPhoto(file);
      await client.uploadPhoto(pendingMission, dataUrl, geo.pos ? { lat: geo.pos.lat, lng: geo.pos.lng } : null);
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
          <small>Next Photo</small>
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
        {isChaser && violators.length > 0 && (
          <button className="btn ghost small" onClick={() => setMuted((m) => !m)}>{muted ? '🔇 消音中' : '🔊 消音'}</button>
        )}
      </div>

      {isChaser && violators.length > 0 && (
        <div className="alert-banner">🚨 エリア外: {violators.map((v) => v.name).join('、')} の現在地を公開中</div>
      )}
      {myViolation && <div className="alert-banner">⚠️ エリア外です！追跡者に現在地が公開されています。すぐに戻ってください</div>}
      {geo.error && <div className="warn-banner">{geo.error}</div>}

      <MapView className="game-map" area={area} markers={markers} fitKey="game" initialCenter={room.settings.center} />

      <div className="actions">
        {me.role === 'runner' && !me.captured && (
          <button className={`btn ${pendingMission ? 'primary pulse' : 'secondary'}`} disabled={!pendingMission} onClick={() => fileInput.current?.click()}>
            📸 自撮りミッション
          </button>
        )}
        <button className="btn secondary" onClick={() => setSheet('photos')}>
          🖼 ヒント写真ログ ({room.photos.length})
        </button>
        {isChaser && (
          <button className="btn danger" onClick={() => setSheet('capture')}>
            🤝 確保完了
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
            <button className="btn primary big" disabled={uploading} onClick={() => fileInput.current?.click()}>
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
            {room.photos.length === 0 && <p className="muted">まだ写真はありません。最初の写真は開始10分後です。</p>}
            <div className="gallery">
              {[...room.photos].reverse().map((ph) => (
                <figure key={ph.id}>
                  <a href={ph.url} target="_blank" rel="noreferrer"><img src={ph.url} alt="" loading="lazy" /></a>
                  <figcaption>
                    {ph.playerName} · #{ph.mission} · {timeOf(ph.t)}
                    {ph.pos && geo.pos && <> · 約{(haversineM(ph.pos, geo.pos) / 1000).toFixed(1)}km先</>}
                  </figcaption>
                </figure>
              ))}
            </div>
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
