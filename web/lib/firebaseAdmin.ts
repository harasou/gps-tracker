import { getApps, initializeApp, applicationDefault, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

// Firebase Admin SDK を 1 度だけ初期化して使い回す。
//
// - App Hosting / Cloud Run 上では Application Default Credentials (ADC) が
//   自動で注入されるため、明示的な鍵は不要。
// - ローカルでは環境変数 GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント
//   JSON のパスを指定すれば ADC として読み込まれる(.env.example 参照)。

let app: App;

if (getApps().length === 0) {
  app = initializeApp({
    credential: applicationDefault(),
  });
} else {
  app = getApps()[0];
}

export const db: Firestore = getFirestore(app);

// 位置情報を格納する Firestore コレクション名
export const LOCATIONS_COLLECTION = "locations";
