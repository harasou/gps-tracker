"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LocationPoint } from "@/lib/types";
import MapView, { type MapMeta, SLOT_MS, DAY_MS, jstHMms } from "./MapView";
import DateInput from "./DateInput";

// "YYYY-MM-DD" から delta 日ずらした JST 暦日を返す。
function shiftDay(day: string, delta: number): string {
  const t = Date.parse(`${day}T12:00:00+09:00`) + delta * DAY_MS;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

// 地図と、その下の時間ナビ(日付+30分枠)をまとめる。
// 30 分枠の選択状態はここで持ち、地図(MapView)へ渡す。
export default function MapArea({
  apiKey,
  points,
  day,
  today,
  deviceId,
  initialSlotIndex,
  meta,
}: {
  apiKey: string;
  points: LocationPoint[];
  day: string;
  today: string;
  deviceId?: string;
  // 矢印で日をまたいだ時の着地枠(0..47)。無ければ最新枠。
  initialSlotIndex?: number;
  meta: MapMeta;
}) {
  const router = useRouter();
  // その日の 00:00(JST) と 各点時刻。
  const dayStartMs = useMemo(() => Date.parse(`${day}T00:00:00+09:00`), [day]);
  const lastMs = points.length ? Date.parse(points[points.length - 1].recordedAt) : dayStartMs;
  const slotOf = (ms: number) => dayStartMs + Math.floor((ms - dayStartMs) / SLOT_MS) * SLOT_MS;

  // 選択中の 30 分枠(開始 ms)。URL に slot 指定があればそれ、無ければ最新点の枠。
  const [slotStartMs, setSlotStartMs] = useState<number>(
    initialSlotIndex != null ? dayStartMs + initialSlotIndex * SLOT_MS : slotOf(lastMs),
  );

  // 初回マウントは上の初期値(URL の slot 指定)を尊重。以降(同日データ再取得など)は最新枠へ。
  const inited = useRef(false);
  useEffect(() => {
    if (!inited.current) {
      inited.current = true;
      return;
    }
    setSlotStartMs(dayStartMs + Math.floor((lastMs - dayStartMs) / SLOT_MS) * SLOT_MS);
  }, [points, dayStartMs, lastMs]);

  // 枠ごとの点数(ドロップダウンに出す)。
  const slotCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of points) {
      const idx = Math.floor((Date.parse(p.recordedAt) - dayStartMs) / SLOT_MS);
      m.set(idx, (m.get(idx) ?? 0) + 1);
    }
    return m;
  }, [points, dayStartMs]);

  const btn =
    "rounded border border-neutral-300 px-3 py-2 text-base hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-neutral-700 dark:hover:bg-neutral-800";
  const atLast = slotStartMs >= dayStartMs + DAY_MS - SLOT_MS;
  // 今日の最終枠より先(未来)へは進めない。
  const nextBlocked = atLast && day >= today;

  // 別の日付の指定枠へ遷移する(矢印の日またぎ)。
  function navTo(d: string, slotIdx: number) {
    const p = new URLSearchParams();
    p.set("date", d);
    p.set("slot", String(slotIdx));
    if (deviceId) p.set("deviceId", deviceId);
    router.push(`/map?${p.toString()}`);
  }

  // ◀: 枠内は −30分。先頭(00:00)なら前日の 23:30 へ。
  function goPrev() {
    if (slotStartMs > dayStartMs) setSlotStartMs(slotStartMs - SLOT_MS);
    else navTo(shiftDay(day, -1), 47);
  }

  // ▶: 枠内は +30分。末尾(23:30)なら翌日の 00:00 へ(未来日は不可)。
  function goNext() {
    if (!atLast) setSlotStartMs(slotStartMs + SLOT_MS);
    else if (!nextBlocked) navTo(shiftDay(day, 1), 0);
  }

  // 「更新」= 今へ。今日でなければ今日へ遷移、今日なら再取得して最新枠へ。
  function onUpdate() {
    if (day === today) {
      router.refresh();
      setSlotStartMs(slotOf(lastMs));
    } else {
      const p = new URLSearchParams();
      p.set("date", today);
      if (deviceId) p.set("deviceId", deviceId);
      router.push(`/map?${p.toString()}`);
    }
  }

  return (
    <>
      <div className="flex flex-1 flex-col">
        {!apiKey ? (
          <div className="p-6 text-red-600">
            GOOGLE_MAPS_API_KEY が設定されていません。README のセットアップ手順を参照してください。
          </div>
        ) : points.length === 0 ? (
          <div className="p-6 text-neutral-500">
            この日の位置情報がありません。日付を変えて直近を表示してください。
          </div>
        ) : (
          <MapView apiKey={apiKey} points={points} meta={meta} slotStartMs={slotStartMs} />
        )}
      </div>

      {/* 下部ナビ: 左に ◀ 日付 時間 ▶ / 右に 更新。date はネイティブカレンダー。 */}
      <div className="flex items-center gap-2 border-t border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <button onClick={goPrev} className={`${btn} shrink-0`} aria-label="30分前(前日へ繰越)">
          ◀
        </button>
        <DateInput current={day} deviceId={deviceId} />
        <select
          value={slotStartMs}
          onChange={(e) => setSlotStartMs(Number(e.target.value))}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-2 text-base tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          aria-label="時間帯(30分)を選択"
        >
          {Array.from({ length: 48 }, (_, i) => {
            const ms = dayStartMs + i * SLOT_MS;
            const n = slotCounts.get(i) ?? 0;
            return (
              <option key={i} value={ms}>
                {jstHMms(ms)}〜{n > 0 ? ` (${n})` : ""}
              </option>
            );
          })}
        </select>
        <button
          onClick={goNext}
          className={`${btn} shrink-0`}
          disabled={nextBlocked}
          aria-label="30分後(翌日へ繰越)"
        >
          ▶
        </button>
        <button onClick={onUpdate} className={`${btn} shrink-0`} aria-label="今日の最新へ">
          更新
        </button>
      </div>
    </>
  );
}
