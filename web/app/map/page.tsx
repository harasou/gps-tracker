import type { Query } from "firebase-admin/firestore";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEVICE_ID_COOKIE } from "@/lib/deviceIdCookie";
import { db, LOCATIONS_COLLECTION } from "@/lib/firebaseAdmin";
import type { LocationPoint } from "@/lib/types";
import MapArea from "./MapArea";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 一度に地図へ描画する最大点数
const MAX_POINTS = 2000;

// 描画から除外する測位品質のしきい値。
// - 精度(誤差半径)がこれ以上の点は不正確なので描画しない。地下や屋内で
//   基地局ベースの粗い fix が返ると軌跡が飛ぶため。
const MAX_ACCURACY_M = 100;
// - 直前の採用点からの移動速度がこれを超える点は物理的にありえない飛びとして除外。
const MAX_SPEED_KMH = 300;
// - スパイク除去: A→B→C で B だけ大きく寄り道して戻る点(=誤測位のテレポート)を外す。
//   B が前点から SPIKE_MIN_M 以上離れ、かつ寄り道率 (|AB|+|BC|)/|AC| が
//   SPIKE_RATIO を超えたら B を除外。地下/屋内で精度を低く詐称した fix は
//   精度・速度フィルタを抜けるが、この形状(飛んで戻る)で捕まえられる。
const SPIKE_MIN_M = 200;
const SPIKE_RATIO = 4;

interface Filtered {
  points: LocationPoint[];
  excludedByAccuracy: number;
  excludedBySpeed: number;
  excludedBySpike: number;
}

// 2 点間の距離(メートル)。ハバーサイン。
function haversineM(a: LocationPoint, b: LocationPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 「飛んで戻る」スパイク点を反復的に除去する。points は時刻昇順であること。
// 直前の採用点 A・当該点 B・次点 C を見て、B が寄り道スパイクなら B を落とす。
// 1 点除くと隣の三角形が変わるため、変化がなくなるまで数回繰り返す。
function despike(points: LocationPoint[]): { points: LocationPoint[]; removed: number } {
  let arr = points;
  let removed = 0;
  for (let pass = 0; pass < 5; pass++) {
    if (arr.length < 3) break;
    const out: LocationPoint[] = [arr[0]];
    let changed = false;
    for (let i = 1; i < arr.length - 1; i++) {
      const a = out[out.length - 1];
      const b = arr[i];
      const c = arr[i + 1];
      const ab = haversineM(a, b);
      const ratio = (ab + haversineM(b, c)) / Math.max(haversineM(a, c), 1);
      if (ab > SPIKE_MIN_M && ratio > SPIKE_RATIO) {
        removed += 1;
        changed = true;
        continue; // B を捨てる
      }
      out.push(b);
    }
    out.push(arr[arr.length - 1]);
    arr = out;
    if (!changed) break;
  }
  return { points: arr, removed };
}

// 品質フィルタ。points は時刻昇順であること。
// 1) 精度が粗い点 → 2) 非現実的な速度で飛ぶ点 → 3) 飛んで戻るスパイク点、の順に除外。
function filterPoints(points: LocationPoint[]): Filtered {
  const byAccuracy = points.filter(
    (p) => !(p.accuracy !== undefined && p.accuracy >= MAX_ACCURACY_M),
  );
  const excludedByAccuracy = points.length - byAccuracy.length;

  const maxMps = (MAX_SPEED_KMH * 1000) / 3600;
  const bySpeed: LocationPoint[] = [];
  let excludedBySpeed = 0;
  for (const p of byAccuracy) {
    const prev = bySpeed[bySpeed.length - 1];
    if (prev) {
      const dtSec = (Date.parse(p.recordedAt) - Date.parse(prev.recordedAt)) / 1000;
      // dt<=0(時刻逆転/同時刻)は速度計算せず採用する。
      if (dtSec > 0 && haversineM(prev, p) / dtSec > maxMps) {
        excludedBySpeed += 1;
        continue;
      }
    }
    bySpeed.push(p);
  }

  const { points: kept, removed: excludedBySpike } = despike(bySpeed);

  return { points: kept, excludedByAccuracy, excludedBySpeed, excludedBySpike };
}

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
): Promise<{
  points: LocationPoint[];
  noFixCount: number;
  rawLocated: number;
  excludedByAccuracy: number;
  excludedBySpeed: number;
  excludedBySpike: number;
}> {
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

  // 測位品質フィルタ(精度・速度)を適用。除外内訳も返す。
  const rawLocated = points.length;
  const filtered = filterPoints(points);
  return {
    points: filtered.points,
    noFixCount,
    rawLocated,
    excludedByAccuracy: filtered.excludedByAccuracy,
    excludedBySpeed: filtered.excludedBySpeed,
    excludedBySpike: filtered.excludedBySpike,
  };
}

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ deviceId?: string; date?: string; slot?: string }>;
}) {
  const { deviceId: queryDeviceId, date, slot } = await searchParams;
  const cookieStore = await cookies();
  // URL 指定を優先し、無ければ cookie の端末IDを使う。どちらも無ければトップの入力画面へ。
  // (全端末分をデフォルトで見せない — deviceId 必須にすることが実質的なアクセス制御)
  const deviceId = queryDeviceId || cookieStore.get(DEVICE_ID_COOKIE)?.value || undefined;
  if (!deviceId) {
    redirect("/");
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? "";
  const today = jstDay(0);
  // 日付未指定なら今日を表示する。
  const day = date && DAY_RE.test(date) ? date : today;
  // 矢印/カレンダーで指定された枠。"day" なら24時間表示、0..47 なら30分枠、
  // 無ければ最新枠。
  const initialSlotIndex: number | "day" | undefined =
    slot === "day"
      ? "day"
      : slot !== undefined && /^\d{1,2}$/.test(slot)
        ? Math.min(47, Math.max(0, parseInt(slot, 10)))
        : undefined;
  const {
    points,
    noFixCount,
    rawLocated,
    excludedByAccuracy,
    excludedBySpeed,
    excludedBySpike,
  } = await fetchPoints(deviceId, day);

  const rangeLabel = `${day}（${weekdayJa(day)}）`;
  const excludedTotal = excludedByAccuracy + excludedBySpeed + excludedBySpike;
  // 測位できた点(rawLocated)に対する除外割合。
  const excludedPct =
    rawLocated > 0 ? Math.round((excludedTotal / rawLocated) * 1000) / 10 : 0;

  return (
    <main className="flex h-dvh flex-col">
      <MapArea
        apiKey={apiKey}
        points={points}
        day={day}
        today={today}
        deviceId={deviceId}
        initialSlotIndex={initialSlotIndex}
        meta={{
          noFixCount,
          excludedByAccuracy,
          excludedBySpeed,
          excludedBySpike,
          excludedTotal,
          excludedPct,
          rangeLabel,
          deviceId,
        }}
      />
    </main>
  );
}
