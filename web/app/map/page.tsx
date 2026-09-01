import type { Query } from "firebase-admin/firestore";
import { db, LOCATIONS_COLLECTION } from "@/lib/firebaseAdmin";
import type { LocationPoint } from "@/lib/types";
import MapView from "./MapView";
import DateInput from "./DateInput";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 一度に地図へ描画する最大点数
const MAX_POINTS = 2000;

// 日付は JST(日本時間)の暦日として解釈する。保存は UTC なので境界を変換する。
const TZ = "Asia/Tokyo";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// n 日前の JST 暦日を "YYYY-MM-DD" で返す。
function jstDay(daysAgo: number): string {
  return fmtDay(new Date(Date.now() - daysAgo * 86_400_000));
}

// Date を JST 暦日 "YYYY-MM-DD" に整形(en-CA ロケールは YYYY-MM-DD)。
function fmtDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// "YYYY-MM-DD" から delta 日ずらした JST 暦日を返す。
function shiftDay(day: string, delta: number): string {
  // 正午 JST を基準にすることで DST 等の境界ズレを避ける。
  const t = Date.parse(`${day}T12:00:00+09:00`);
  return fmtDay(new Date(t + delta * 86_400_000));
}

// 選択日の曜日(月〜日)を返す。
function weekdayJa(day: string): string {
  const t = Date.parse(`${day}T12:00:00+09:00`);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, weekday: "short" }).format(
    new Date(t),
  );
}

async function fetchPoints(
  deviceId: string | undefined,
  day: string | undefined,
): Promise<{ points: LocationPoint[]; noFixCount: number }> {
  let query: Query = db.collection(LOCATIONS_COLLECTION);

  if (deviceId) query = query.where("deviceId", "==", deviceId);

  if (day && DAY_RE.test(day)) {
    const fromIso = new Date(Date.parse(`${day}T00:00:00.000+09:00`)).toISOString();
    const toIso = new Date(Date.parse(`${day}T23:59:59.999+09:00`)).toISOString();
    query = query.where("recordedAt", ">=", fromIso).where("recordedAt", "<=", toIso);
  }

  query = query.orderBy("recordedAt", "desc").limit(MAX_POINTS);

  const snap = await query.get();
  const points: LocationPoint[] = [];
  let noFixCount = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    // 位置不明レコード(hasLocation===false)は地図に描かず件数だけ数える。
    if (d.hasLocation === false) {
      noFixCount += 1;
      continue;
    }
    const lat = Number(d.latitude);
    const lng = Number(d.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push({
      lat,
      lng,
      recordedAt: String(d.recordedAt ?? ""),
      accuracy: d.accuracy !== undefined ? Number(d.accuracy) : undefined,
    });
  }

  // recordedAt desc で取得したので、軌跡を古い→新しい順に並べ替える。
  points.reverse();
  return { points, noFixCount };
}

// リンク先を組み立てる(deviceId は引き継ぐ)。day 未指定なら全期間。
function dayHref(day: string, deviceId: string | undefined): string {
  const p = new URLSearchParams();
  if (day) p.set("date", day);
  if (deviceId) p.set("deviceId", deviceId);
  const qs = p.toString();
  return qs ? `/map?${qs}` : "/map";
}

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ deviceId?: string; date?: string }>;
}) {
  const { deviceId, date } = await searchParams;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? "";
  const today = jstDay(0);
  // 日付未指定なら今日を表示する。
  const day = date && DAY_RE.test(date) ? date : today;
  const { points, noFixCount } = await fetchPoints(deviceId, day);

  const rangeLabel = `${day}（${weekdayJa(day)}）`;

  return (
    <main className="flex h-dvh flex-col">
      <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">GPS Tracker — 軌跡</h1>
          <span className="text-sm text-neutral-500">
            {points.length} 点
            {noFixCount > 0 ? ` / 位置不明 ${noFixCount} 件` : ""} / {rangeLabel}
            {deviceId ? ` / device: ${deviceId}` : ""}
          </span>
        </div>

        {/* 日付フィルタ。date 入力はネイティブのカレンダーを開き、選ぶと即反映。 */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {/* 前日 */}
          <a
            href={dayHref(shiftDay(day, -1), deviceId)}
            className="rounded border border-neutral-300 px-2 py-1.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            aria-label="前日"
          >
            ◀ 前日
          </a>

          <DateInput current={day} deviceId={deviceId} />

          {/* 翌日 */}
          <a
            href={dayHref(shiftDay(day, 1), deviceId)}
            className="rounded border border-neutral-300 px-2 py-1.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            aria-label="翌日"
          >
            翌日 ▶
          </a>

          <a
            href={dayHref(today, deviceId)}
            className="rounded border border-neutral-300 px-2 py-1.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            今日
          </a>
        </div>
      </header>

      {!apiKey ? (
        <div className="p-6 text-red-600">
          GOOGLE_MAPS_API_KEY が設定されていません。README のセットアップ手順を参照してください。
        </div>
      ) : points.length === 0 ? (
        <div className="p-6 text-neutral-500">
          この日の位置情報がありません。日付を変えるか「全期間」で直近を表示してください。
        </div>
      ) : (
        <MapView apiKey={apiKey} points={points} />
      )}
    </main>
  );
}
