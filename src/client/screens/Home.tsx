import { useState } from 'react';
import { unlockAudio } from '../device.ts';
import { client, useClient } from '../net.ts';

export function Home() {
  const { name, connected } = useClient();
  const [code, setCode] = useState('');
  const [guide, setGuide] = useState(false);
  const nameOk = name.trim().length > 0;

  return (
    <div className="screen home">
      <header className="hero">
        <div className="hero-badge">REAL CHASE GAME</div>
        <h1>リアル<br />探してください</h1>
        <p className="muted">GPSで遊ぶ、現代版ドロケイ</p>
      </header>

      <label className="field">
        <span>ニックネーム</span>
        <input
          value={name}
          maxLength={16}
          placeholder="例: たろう"
          onChange={(e) => client.setName(e.target.value)}
        />
      </label>

      <button
        className="btn primary big"
        disabled={!nameOk || !connected}
        onClick={() => {
          unlockAudio();
          client.create();
        }}
      >
        部屋を作る（ホスト）
      </button>

      <div className="divider"><span>または</span></div>

      <div className="join-row">
        <input
          className="code-input"
          inputMode="numeric"
          pattern="\d*"
          maxLength={5}
          placeholder="5桁のルームコード"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
        />
        <button
          className="btn secondary"
          disabled={!nameOk || code.length !== 5 || !connected}
          onClick={() => {
            unlockAudio();
            client.join(code);
          }}
        >
          部屋に入る
        </button>
      </div>

      {!connected && <p className="muted center">サーバーに接続中…</p>}

      <button className="link" onClick={() => setGuide(true)}>遊び方ガイド</button>

      {guide && (
        <div className="modal-backdrop" onClick={() => setGuide(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>遊び方</h2>
            <ol className="guide">
              <li><b>5人</b>で「逃走者」と「追跡者」に分かれます（1vs4 / 2vs3 / 3vs2）。</li>
              <li>ホストが地図に<b>中心ピン</b>を立て、半径（標準3km）のエリアを決めます。</li>
              <li>制限時間（30/45/60分）まで逃げ切れば<b>逃走者の勝ち</b>。全員確保で<b>追跡者の勝ち</b>。</li>
              <li>逃走者は<b>10分ごとに自撮り</b>を送信。顔と背景が写るように撮ろう。写真と撮影場所は追跡者に共有されます。</li>
              <li>逃走者がエリアの外に出ると、追跡者の画面に<b>警報音とともに現在地が公開</b>されます（戻るまで継続）。</li>
              <li>追跡者は逃走者にタッチしたら「確保」を押し、逃走者が自分の端末で承認すると確保成立です。</li>
              <li>地図の🎁に近づくとアイテムGET。逃走者は<b>🫥透明化</b>（自撮り1回スキップ）か<b>👣偽の足跡</b>、追跡者は<b>📡10秒レーダー</b>。</li>
              <li>🔥チャレンジ地点で自撮りすると逃げ切りボーナス<b>×3</b>。でも写真と場所は追跡者にバレます。</li>
              <li>ポイント: 逃走者は生存1分+1・自撮り+5・逃げ切り+30、追跡者は確保+50・勝利+20。最後にランキング発表！</li>
            </ol>
            <p className="muted small">プレイ中は画面を点けたままにしてください。交通ルールと周囲の安全を最優先に。</p>
            <button className="btn primary" onClick={() => setGuide(false)}>閉じる</button>
          </div>
        </div>
      )}
    </div>
  );
}
