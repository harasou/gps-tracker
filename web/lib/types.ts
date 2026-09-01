// Android アプリが 1 回の POST で送ってくる位置情報 1 点。
// タイムスタンプはクライアント(端末)側の記録時刻を ISO8601 文字列で送る。
export interface LocationInput {
  latitude: number;
  longitude: number;
  // 端末で記録した時刻 (ISO8601, 例 "2026-09-01T09:12:34.567Z")
  recordedAt: string;
  // 以下は任意
  accuracy?: number; // 水平精度 (m)
  altitude?: number; // 高度 (m)
  speed?: number; // 速度 (m/s)
  bearing?: number; // 進行方位 (度)
}

// Firestore に保存する 1 ドキュメントの形。
export interface LocationDoc extends LocationInput {
  deviceId: string; // どの端末からの記録か
  createdAt: string; // サーバ受信時刻 (ISO8601)
}

// 地図ページがクライアントに渡す 1 点(必要な項目だけ)。
export interface LocationPoint {
  lat: number;
  lng: number;
  recordedAt: string;
  accuracy?: number;
}
