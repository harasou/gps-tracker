# GPS Tracker

Android 端末の位置情報を一定間隔で外部サーバに保存し、その軌跡を Google マップ上で確認するアプリ一式。

```
┌─────────────┐   HTTPS POST      ┌──────────────────────────┐        ┌───────────┐
│ Android app │ ──(位置情報)────▶ │ Next.js API (/api/locations)│ ─────▶│ Firestore │
│ (Kotlin)    │   一定間隔          │ Firebase App Hosting        │  write │ locations │
└─────────────┘                    │                            │        └─────┬─────┘
                                    │ /map (Google Maps JS)      │◀─────────────┘
                                    └──────────────────────────┘   read
                                          ブラウザで軌跡を閲覧
```

## 構成

| ディレクトリ | 内容 | 技術 |
|--------------|------|------|
| [`web/`](./web) | 位置情報の受信 API と地図ページ | Next.js 16 + TypeScript + Firebase (Firestore) / App Hosting |
| [`android/`](./android) | 位置情報を記録して送信するアプリ | Kotlin + Jetpack Compose + FusedLocationProvider |

`books` / `zoolink` と同じ **Next.js + Firebase (App Hosting + Firestore)** スタックに揃えている。

---

## セットアップ

### 1. Firebase プロジェクトを作る

```bash
# 未インストールなら
npm install -g firebase-tools
firebase login

# プロジェクト作成(コンソール https://console.firebase.google.com でも可)
firebase projects:create gps-tracker-xxxxx   # ID は世界で一意

# Firestore を有効化(コンソール: Build > Firestore Database > データベース作成 / 本番モード)
```

作成したプロジェクト ID を `web/.firebaserc` の `CHANGE_ME_FIREBASE_PROJECT_ID` に設定する。

### 2. Google Maps API キーを取得する

1. [Google Cloud Console](https://console.cloud.google.com) を開き、上部のプロジェクト選択で **手順1で作った Firebase プロジェクトと同じもの**（例: `gps-tracker-30962`）を選ぶ
   - Firebase プロジェクトは中身が Google Cloud プロジェクトそのもの。手順1で作ると同じ ID の GCP プロジェクトが自動でひも付く。Maps キーも同じプロジェクトで作ると課金・管理が 1 つにまとまる
2. 「API とサービス」→「ライブラリ」で **Maps JavaScript API** を有効化
3. 「認証情報」→「認証情報を作成」→「API キー」
4. 作成したキーに **アプリケーションの制限**(HTTP リファラー = デプロイ先ドメイン)と **API の制限**(Maps JavaScript API のみ)をかける

### 3. シークレットを登録する（App Hosting）

`apphosting.yaml` は値を直書きせず Secret Manager を参照する。

```bash
cd web
# Android 認証用トークン(長いランダム文字列)
openssl rand -hex 32          # 出た値をメモ → Android アプリにも同じ値を入れる
firebase apphosting:secrets:set DEVICE_TOKEN

# Google Maps API キー
firebase apphosting:secrets:set GOOGLE_MAPS_API_KEY
```

### 4. デプロイ

```bash
cd web
# Firestore ルール/インデックス
firebase deploy --only firestore

# App Hosting バックエンド(初回はバックエンド作成のウィザードが出る。backendId は gps-tracker)
firebase deploy --only apphosting
```

デプロイ後に払い出される URL（例 `https://gps-tracker--xxxx.web.app`）が本番の公開先。
- 位置情報 POST 先: `https://<URL>/api/locations`
- 地図: `https://<URL>/map`

---

## ローカル開発（web）

```bash
cd web
npm install
cp .env.example .env.local     # 値を埋める(下記参照)
npm run dev                    # http://localhost:3000
```

`.env.local` に必要な値:

| 変数 | 説明 |
|------|------|
| `DEVICE_TOKEN` | Android からの POST を認証する共有トークン |
| `GOOGLE_MAPS_API_KEY` | Maps JavaScript API キー |
| `GOOGLE_APPLICATION_CREDENTIALS` | Firestore を叩く管理者鍵 JSON へのパス（Firebase コンソール > プロジェクト設定 > サービスアカウント で発行） |
| `GOOGLE_CLOUD_PROJECT` | Firebase プロジェクト ID |

動作確認（ローカルへ 1 点 POST）:

```bash
curl -X POST http://localhost:3000/api/locations \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "X-Device-Id: test-device" \
  -H "Content-Type: application/json" \
  -d '{"latitude":35.681236,"longitude":139.767125,"recordedAt":"2026-09-01T09:00:00.000Z"}'
# → {"accepted":1,"rejected":0}
```

その後 `http://localhost:3000/map` を開くと軌跡が出る。

---

## Android アプリ

### ビルド

1. **Android Studio**（Ladybug 以降推奨）で `android/` フォルダを開く
2. 初回同期で Gradle wrapper・Android SDK・依存が自動で揃う
   - ※ `gradle/wrapper/gradle-wrapper.jar` はリポジトリに含めていないため、CLI から `./gradlew` を使いたい場合は一度 Android Studio で開くか、`gradle wrapper` を実行して生成する
3. 実機（USB デバッグ有効）または エミュレータで Run

### アプリ内設定

| 項目 | 説明 |
|------|------|
| サーバ URL | `https://<デプロイ先>/api/locations` |
| デバイストークン | `DEVICE_TOKEN` に登録したのと同じ値 |
| 記録間隔(秒) | 例: 60。この間隔ごとに必ず 1 件送信する |

「設定を保存」→「位置情報の権限をリクエスト」→「記録を開始」。
画面を消してもバックグラウンドで記録し続けるには、端末の設定で位置情報を **「常に許可」** にする（Android 10 以降）。

### 記録の仕組み・注意

- 前面サービスが **タイマーで能動的に現在地を要求**し、**間隔ごとに必ず 1 件送信**する（静止中でも送る）。
- その時刻に測位できなかった場合は、座標なしの **「位置不明」レコード**（`locationAvailable:false`）を送る。ネットワークが生きていれば「位置は取れなかったが端末は動いていた」記録が残る。地図には描かず、地図ヘッダに「位置不明 N 件」と件数表示する。
- 通信不能時は端末内（`buffer.jsonl`）にバッファし、次の送信成功時にまとめて送り直す。
- 前面サービス（常駐通知）として動くため、OS に強制終了されにくい。

---

## データモデル（Firestore `locations`）

位置が取れたレコード:

```jsonc
{
  "deviceId": "android-1a2b3c4d",
  "latitude": 35.681236,
  "longitude": 139.767125,
  "recordedAt": "2026-09-01T09:00:00.000Z", // 端末の記録時刻
  "locationAvailable": true,
  "hasLocation": true,                        // 地図描画対象
  "accuracy": 8.0,                            // 任意
  "altitude": 40.0,                           // 任意
  "speed": 1.2,                               // 任意
  "bearing": 90.0,                            // 任意
  "createdAt": "2026-09-01T09:00:01.123Z",   // サーバ受信時刻
  "_serverTs": <serverTimestamp>
}
```

測位できなかったレコード（座標なし・地図には描かない）:

```jsonc
{
  "deviceId": "android-1a2b3c4d",
  "recordedAt": "2026-09-01T09:01:00.000Z",
  "locationAvailable": false,
  "hasLocation": false,
  "createdAt": "2026-09-01T09:01:01.000Z",
  "_serverTs": <serverTimestamp>
}
```

クライアント（ブラウザ / Android）は Firestore に直接アクセスしない。書き込みは `/api/locations`、
読み取りは地図ページのサーバコンポーネントが、いずれも Admin SDK 経由で行う。Firestore ルールは
クライアント SDK からのアクセスを全拒否している。

---

## 今後の拡張候補

- 地図ページに **日付レンジ絞り込み**（`MAX_POINTS = 2000` で直近しか出ないため、期間指定で古い軌跡も見られるように）
- 端末ごとの色分け・複数端末の同時表示
- 表示側の距離間引き（滞在クラスタの集約表示）
```
