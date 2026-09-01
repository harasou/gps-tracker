import { db, LOCATIONS_COLLECTION } from "@/lib/firebaseAdmin";
import type { LocationPoint } from "@/lib/types";
import MapView from "./MapView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 一度に地図へ描画する最大点数
const MAX_POINTS = 2000;

async function fetchPoints(deviceId?: string): Promise<LocationPoint[]> {
  let query = db
    .collection(LOCATIONS_COLLECTION)
    .orderBy("recordedAt", "desc")
    .limit(MAX_POINTS);

  if (deviceId) {
    query = db
      .collection(LOCATIONS_COLLECTION)
      .where("deviceId", "==", deviceId)
      .orderBy("recordedAt", "desc")
      .limit(MAX_POINTS);
  }

  const snap = await query.get();
  const points: LocationPoint[] = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      lat: Number(d.latitude),
      lng: Number(d.longitude),
      recordedAt: String(d.recordedAt ?? ""),
      accuracy: d.accuracy !== undefined ? Number(d.accuracy) : undefined,
    };
  });

  // recordedAt desc で取得したので、軌跡を古い→新しい順に並べ替える。
  points.reverse();
  return points;
}

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ deviceId?: string }>;
}) {
  const { deviceId } = await searchParams;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? "";
  const points = await fetchPoints(deviceId);

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <h1 className="text-lg font-semibold">GPS Tracker — 軌跡</h1>
        <span className="text-sm text-neutral-500">
          {points.length} 点
          {deviceId ? ` / device: ${deviceId}` : ""}
        </span>
      </header>

      {!apiKey ? (
        <div className="p-6 text-red-600">
          GOOGLE_MAPS_API_KEY が設定されていません。README のセットアップ手順を参照してください。
        </div>
      ) : points.length === 0 ? (
        <div className="p-6 text-neutral-500">
          まだ位置情報がありません。Android アプリから記録を送信してください。
        </div>
      ) : (
        <MapView apiKey={apiKey} points={points} />
      )}
    </main>
  );
}
