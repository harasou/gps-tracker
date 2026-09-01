import type { Query } from "firebase-admin/firestore";
import { db, LOCATIONS_COLLECTION } from "@/lib/firebaseAdmin";
import type { LocationPoint } from "@/lib/types";
import MapView from "./MapView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 一度に地図へ描画する最大点数
const MAX_POINTS = 2000;

// 日付は JST(日本時間)の暦日として解釈する。保存は UTC なので境界を変換する。
const TZ = "Asia/Tokyo";

// n 日前の JST 暦日を "YYYY-MM-DD" で返す。
function jstDay(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  // en-CA ロケールは YYYY-MM-DD 形式
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// "YYYY-MM-DD"(JST) → その日の 00:00:00 JST を UTC ISO8601 に。
function jstStartIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00+09:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// "YYYY-MM-DD"(JST) → その日の 23:59:59.999 JST を UTC ISO8601 に。
function jstEndIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T23:59:59.999+09:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

async function fetchPoints(
  deviceId: string | undefined,
  fromDay: string | undefined,
  toDay: string | undefined,
): Promise<LocationPoint[]> {
  let query: Query = db.collection(LOCATIONS_COLLECTION);

  if (deviceId) query = query.where("deviceId", "==", deviceId);

  const fromIso = fromDay ? jstStartIso(fromDay) : null;
  const toIso = toDay ? jstEndIso(toDay) : null;
  if (fromIso) query = query.where("recordedAt", ">=", fromIso);
  if (toIso) query = query.where("recordedAt", "<=", toIso);

  query = query.orderBy("recordedAt", "desc").limit(MAX_POINTS);

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

// プリセットのリンク先を組み立てる(deviceId は引き継ぐ)。
function presetHref(
  from: string,
  to: string,
  deviceId: string | undefined,
): string {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  if (deviceId) p.set("deviceId", deviceId);
  const qs = p.toString();
  return qs ? `/map?${qs}` : "/map";
}

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ deviceId?: string; from?: string; to?: string }>;
}) {
  const { deviceId, from, to } = await searchParams;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? "";
  const points = await fetchPoints(deviceId, from, to);

  const today = jstDay(0);
  const presets = [
    { label: "今日", from: today, to: today },
    { label: "過去7日", from: jstDay(6), to: today },
    { label: "過去30日", from: jstDay(29), to: today },
  ];

  const rangeLabel =
    from || to ? `${from ?? "…"} 〜 ${to ?? "…"}（JST）` : "全期間(直近)";

  return (
    <main className="flex h-dvh flex-col">
      <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">GPS Tracker — 軌跡</h1>
          <span className="text-sm text-neutral-500">
            {points.length} 点 / {rangeLabel}
            {deviceId ? ` / device: ${deviceId}` : ""}
          </span>
        </div>

        {/* 日付フィルタ: JS 不要のプレーンな GET フォーム */}
        <form method="get" className="mt-2 flex flex-wrap items-end gap-2 text-sm">
          {deviceId ? (
            <input type="hidden" name="deviceId" value={deviceId} />
          ) : null}
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">開始日</span>
            <input
              type="date"
              name="from"
              defaultValue={from ?? ""}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-neutral-500">終了日</span>
            <input
              type="date"
              name="to"
              defaultValue={to ?? ""}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700"
          >
            表示
          </button>

          <span className="mx-1 text-neutral-300 dark:text-neutral-700">|</span>

          {presets.map((p) => (
            <a
              key={p.label}
              href={presetHref(p.from, p.to, deviceId)}
              className="rounded border border-neutral-300 px-2 py-1.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {p.label}
            </a>
          ))}
          <a
            href={presetHref("", "", deviceId)}
            className="rounded px-2 py-1.5 text-neutral-500 underline hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            クリア
          </a>
        </form>
      </header>

      {!apiKey ? (
        <div className="p-6 text-red-600">
          GOOGLE_MAPS_API_KEY が設定されていません。README のセットアップ手順を参照してください。
        </div>
      ) : points.length === 0 ? (
        <div className="p-6 text-neutral-500">
          この期間の位置情報がありません。日付を変えるか「クリア」で全期間表示にしてください。
        </div>
      ) : (
        <MapView apiKey={apiKey} points={points} />
      )}
    </main>
  );
}
