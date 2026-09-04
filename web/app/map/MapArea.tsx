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
  // 矢印/カレンダーでの指定。"day" なら24時間表示、0..47 なら30分枠、無ければ最新枠。
  initialSlotIndex?: number | "day";
  meta: MapMeta;
}) {
  const router = useRouter();
  // その日の 00:00(JST) と 各点時刻。
  const dayStartMs = useMemo(() => Date.parse(`${day}T00:00:00+09:00`), [day]);
  const lastMs = points.length ? Date.parse(points[points.length - 1].recordedAt) : dayStartMs;
  const slotOf = (ms: number) => dayStartMs + Math.floor((ms - dayStartMs) / SLOT_MS) * SLOT_MS;

  // 24時間表示か、30分枠表示か。
  const [fullDay, setFullDay] = useState<boolean>(initialSlotIndex === "day");
  // 選択中の 30 分枠(開始 ms)。URL に slot 指定があればそれ、無ければ最新点の枠。
  const [slotStartMs, setSlotStartMs] = useState<number>(
    typeof initialSlotIndex === "number" ? dayStartMs + initialSlotIndex * SLOT_MS : slotOf(lastMs),
  );

  // 日付送り/カレンダーで URL の day・slot 指定が変わったら、その指定どおりに同期する。
  // (矢印の日またぎは 0 や 47 を明示しているので、ここでその枠が正確に反映される。
  //  ブラウザの戻る/進むで URL だけ変わるケースもここで拾う)
  const navInited = useRef(false);
  useEffect(() => {
    if (!navInited.current) {
      navInited.current = true;
      return;
    }
    if (initialSlotIndex === "day") {
      setFullDay(true);
    } else if (typeof initialSlotIndex === "number") {
      setFullDay(false);
      setSlotStartMs(dayStartMs + initialSlotIndex * SLOT_MS);
    } else {
      // slot 未指定(例:「最新」で今日へ遷移): 最新枠へ。
      setFullDay(false);
      setSlotStartMs(dayStartMs + Math.floor((lastMs - dayStartMs) / SLOT_MS) * SLOT_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, initialSlotIndex]);

  // 同日のまま新しいデータが来た(「最新」など、日付は変わらない)場合だけ、
  // 30分枠モードなら最新の枠へ追従する。日をまたぐ遷移は上の effect が担当する。
  const prevDayRef = useRef(day);
  const dataInited = useRef(false);
  useEffect(() => {
    const sameDay = prevDayRef.current === day;
    prevDayRef.current = day;
    if (!dataInited.current) {
      dataInited.current = true;
      return;
    }
    if (fullDay || !sameDay) return;
    setSlotStartMs(dayStartMs + Math.floor((lastMs - dayStartMs) / SLOT_MS) * SLOT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    "rounded border border-neutral-300 px-3 py-3 text-lg hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-neutral-700 dark:hover:bg-neutral-800";
  const atLast = slotStartMs >= dayStartMs + DAY_MS - SLOT_MS;
  // 今日より先(未来)へは進めない。30分枠モードは最終枠かどうかも見る。
  const nextBlocked = fullDay ? day >= today : atLast && day >= today;

  // 別の日付の指定枠(30分枠 or "day")へ遷移する(矢印の日またぎ・カレンダー選択)。
  function navTo(d: string, slot: number | "day") {
    const p = new URLSearchParams();
    p.set("date", d);
    p.set("slot", String(slot));
    if (deviceId) p.set("deviceId", deviceId);
    router.push(`/map?${p.toString()}`);
  }

  // ◀: 24時間モードなら前日へ。30分枠モードは枠内 −30分、先頭(00:00)なら前日の 23:30 へ。
  function goPrev() {
    if (fullDay) {
      navTo(shiftDay(day, -1), "day");
      return;
    }
    if (slotStartMs > dayStartMs) setSlotStartMs(slotStartMs - SLOT_MS);
    else navTo(shiftDay(day, -1), 47);
  }

  // ▶: 24時間モードなら翌日へ(未来日は不可)。30分枠モードは枠内 +30分、末尾なら翌日の 00:00 へ。
  function goNext() {
    if (fullDay) {
      if (day < today) navTo(shiftDay(day, 1), "day");
      return;
    }
    if (!atLast) setSlotStartMs(slotStartMs + SLOT_MS);
    else if (!nextBlocked) navTo(shiftDay(day, 1), 0);
  }

  // 「更新」= 今へ。今日でなければ今日へ遷移、今日なら再取得して最新枠へ。
  // いずれも30分枠モードに戻す(「最新」は特定の瞬間を見る操作のため)。
  function onUpdate() {
    setFullDay(false);
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
        ) : (
          <MapView apiKey={apiKey} points={points} meta={meta} slotStartMs={slotStartMs} fullDay={fullDay} />
        )}
      </div>

      {/* 常時表示の日付/時間帯ナビ: ◀ 日付 時間帯 ▶ 最新。date はネイティブカレンダー。 */}
      <div className="flex items-center gap-2 border-t border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <button
          onClick={goPrev}
          className={`${btn} shrink-0`}
          aria-label={fullDay ? "前日へ" : "30分前(前日へ繰越)"}
        >
          ◀
        </button>
        <DateInput current={day} deviceId={deviceId} />
        <select
          value={fullDay ? "day" : slotStartMs}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "day") {
              setFullDay(true);
            } else {
              setFullDay(false);
              setSlotStartMs(Number(v));
            }
          }}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-3 text-lg tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          aria-label="時間帯を選択"
        >
          <option value="day">24時間{points.length > 0 ? ` (${points.length})` : ""}</option>
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
          aria-label={fullDay ? "翌日へ" : "30分後(翌日へ繰越)"}
        >
          ▶
        </button>
        <button onClick={onUpdate} className={`${btn} shrink-0`} aria-label="今日の最新へ">
          最新
        </button>
      </div>
    </>
  );
}
