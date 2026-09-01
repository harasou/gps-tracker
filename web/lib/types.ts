// Android アプリが 1 回の POST で送ってくる 1 レコード。
// 位置が取得できた場合は座標を含む。取得できなかった場合は
// locationAvailable=false のみ(座標なし)で「その時刻に測位できなかった」記録として送る。
export interface LocationInput {
  // 位置が取れたときのみ入る
  latitude?: number;
  longitude?: number;
  // 端末で記録した時刻 (ISO8601, 例 "2026-09-01T09:12:34.567Z")
  recordedAt: string;
  // 位置が取れたか。false = 測位できなかった記録
  locationAvailable?: boolean;
  // 以下は位置が取れたときの任意項目
  accuracy?: number; // 水平精度 (m)
  altitude?: number; // 高度 (m)
  speed?: number; // 速度 (m/s)
  bearing?: number; // 進行方位 (度)
}

// Firestore に保存する 1 ドキュメントの形。
export interface LocationDoc extends LocationInput {
  deviceId: string; // どの端末からの記録か
  createdAt: string; // サーバ受信時刻 (ISO8601)
  hasLocation: boolean; // 地図描画対象か(座標を持つか)。クエリ/集計に使う
}

// 地図ページがクライアントに渡す 1 点(座標を持つレコードのみ)。
export interface LocationPoint {
  lat: number;
  lng: number;
  recordedAt: string;
  accuracy?: number;
}
