# リアル探してください（仮） — Catch me if u can

GPS連動のリアル鬼ごっこ（現代版ドロケイ）。5人が「逃走者」と「追跡者」に分かれ、半径3kmのエリアで遊びます。

- フロント: React + Leaflet（OpenStreetMap）のモバイルWebアプリ（静的サイトとしてどこでもホスト可）
- バックエンド: **Supabase**（Postgres の RPC がゲーム判定、Realtime で同期、Storage に自撮り）

## 起動

```bash
cp .env.example .env   # Supabase の URL と publishable key（公開して問題ない値）
npm install
npm run dev            # http://localhost:5173
npm test               # 共通ルール（距離・ミッション時刻など）のテスト
npm run build          # dist/ を Vercel / Netlify / Cloudflare Pages などに配置
```

スマホで位置情報・カメラを使うには **HTTPS** が必要です（localhost は例外）。

## Supabase のセットアップ

プロジェクト: `catch-me-if-ucan`（東京リージョン, ref `ylsnqgihqulrptgsqkas`）

1. `supabase/migrations/` の SQL を番号順に実行（SQL Editor に貼るか `supabase db push`）。何度実行しても安全です。※ `catch-me-if-ucan` プロジェクトには適用済み。
2. `supabase/tests/smoke.sql` を SQL Editor で実行 → エラーが出なければOK（最後にロールバックするのでデータは残りません）。

## 仕組み

```
スマホ ──rpc()──▶ public.* 関数 (SECURITY DEFINER) ──▶ private.* テーブル
  ▲                         │
  └── Realtime "room:<code>" に "changed" ping ◀──┘   → 各自が get_room_view() で自分用の画面を再取得
```

- **生データは `private` スキーマ**にあり、API からは読めません。クライアントは RPC しか呼べず、全ルール（定員・ホスト権限・エリア判定・ミッション・確保）を DB 側で検証します。
- **`get_room_view()` は見る人ごとにフィルタ**します。逃走者の位置が追跡者に見えるのはエリア外の間だけ。
- Realtime のブロードキャストは中身が空の「変わったよ」通知だけなので、ルームコードを知っていても位置は漏れません。オンライン表示は Realtime Presence。
- プレイヤーは端末で生成した秘密キーで識別（DB にはハッシュのみ保存）。Supabase Auth は不要です。
- 自撮りは `reserve_photo` で発行された一回限りのパスにだけアップロードできます（Storage の RLS で制限、JPEG・3MB まで）。
- 時間で起きること（自撮りミッション開始・時間切れ・確保申請の失効）は、クライアントがその時刻に再取得し、DB 側でも呼ばれた時点で判定します。

| ファイル | 内容 |
| --- | --- |
| `supabase/migrations/*_schema.sql` | テーブル・ヘルパー・プレイヤー別ビュー |
| `supabase/migrations/*_rpc.sql` | `create_room` / `join_room` / `set_role` / `set_settings` / `start_game` / `update_location` / `request_capture` / `respond_capture` / `reserve_photo` / `confirm_photo` など |
| `supabase/migrations/*_storage_and_grants.sql` | 自撮りバケット・Storage ポリシー・実行権限 |
| `src/client/net.ts` | RPC 呼び出し、Realtime 購読、写真アップロード |
| `src/shared/game.ts` | 画面表示用の共通ルール（DB 側と同じ計算） |

## 仕様の実装状況

| 仕様 | 実装 |
| --- | --- |
| 1vs4 / 2vs3 / 3vs2、定員超過で役割ロック | ✅ |
| 中心ピン（タップ / 検索 / 現在地）、半径スライダー（既定3.0km, 0.5〜10km） | ✅ 検索は OSM Nominatim |
| 30 / 45 / 60分タイマー、全員準備完了でスタート | ✅ |
| エリア外 → 追跡者画面に赤ピン + 警報音 + 振動（復帰まで継続） | ✅ DB 側で Haversine 判定 |
| 10分ごとの自撮り強制ポップアップ → ヒントログ・地図のカメラピンで共有 | ✅ 未提出分は残り続ける |
| 確保完了ボタン | ✅ 追跡者が申請 → 逃走者が自分の端末で承認すると成立（60秒で失効） |
| リザルト: 勝利チーム・移動軌跡プレイバック・自撮りハイライト | ✅ 再生スライダー付き |
| 通信切断・再読み込みからの復帰 | ✅ |

### 仕様に明記がなく、こちらで決めたルール
- 逃走者には追跡者の位置は見えない。同じチームの仲間の位置は見える。
- 追跡者が逃走者の位置を見られるのはエリア外のときだけ（あとは自撮りの撮影地点）。
- 確保された逃走者はアウト（観戦）。全員確保で追跡者の勝ち、時間切れで逃走者の勝ち。

## 既知の制約・次のステップ
- **バックグラウンド位置取得**: ブラウザは画面オフ中に GPS を止めます。ゲーム中は Wake Lock で画面を点けたままにしていますが、本当のバックグラウンド追跡には Capacitor 等のネイティブラッパーが必要です。
- **古いデータの掃除**: ゲームのロジックは行を消さず（退出は `left_at`、確保申請は `resolved_at` で記録）、履歴がすべて残ります。終了したルームや写真を一定期間後に削除するジョブ（pg_cron）は未実装です。
- **自撮りの公開範囲**: バケットは public（パスは推測不能な UUID）。より厳密にするなら private バケット + 署名付きURL（Edge Function）へ。
- 地図タイルは OSM 公式サーバー。公開運用時は MapTiler 等への切り替えを推奨。
- デモ用に `set_settings` の `p_photo_interval_s`（10〜600秒）で自撮り間隔を短縮できます。
