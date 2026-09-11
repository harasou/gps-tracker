"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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

// 地図と、その下の時間ナビ(日付+1時間枠)をまとめる。
// 1 時間枠の選択状態はここで持ち、地図(MapView)へ渡す。
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
  // 矢印/カレンダーでの指定。"day" なら24時間表示、0..23 なら1時間枠、無ければ最新枠。
  initialSlotIndex?: number | "day";
  meta: MapMeta;
}) {
  const router = useRouter();
  // 日付/24時間切替の遷移(サーバから1日分を取り直す)は時間がかかるため、
  // その間だけ isNavigating を立ててローディング表示・操作ブロックに使う。
  const [isNavigating, startNavigation] = useTransition();
  // その日の 00:00(JST) と 各点時刻。
  const dayStartMs = useMemo(() => Date.parse(`${day}T00:00:00+09:00`), [day]);
  const lastMs = points.length ? Date.parse(points[points.length - 1].recordedAt) : dayStartMs;
  const slotOf = (ms: number) => dayStartMs + Math.floor((ms - dayStartMs) / SLOT_MS) * SLOT_MS;

  // 24時間表示か、1時間枠表示か。
  const [fullDay, setFullDay] = useState<boolean>(initialSlotIndex === "day");
  // 「最新」ボタンで表示中かどうか。true の間は MapView 側のステッパーを
  // 枠の先頭ではなく最終地点(最新の点)に合わせる。他の操作(矢印/カレンダー/
  // 時間帯選択)で明示的に別の枠を見に行ったら解除する。
  const [pinToLatest, setPinToLatest] = useState(false);
  // 選択中の 1 時間枠(開始 ms)。URL に slot 指定があればそれ、無ければ最新点の枠。
  const [slotStartMs, setSlotStartMs] = useState<number>(
    typeof initialSlotIndex === "number" ? dayStartMs + initialSlotIndex * SLOT_MS : slotOf(lastMs),
  );

  // 日付送り/カレンダーで URL の day・slot 指定が変わったら、その指定どおりに同期する。
  // (矢印の日またぎは 0 や 23 を明示しているので、ここでその枠が正確に反映される。
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
  // 1時間枠モードなら最新の枠へ追従する。日をまたぐ遷移は上の effect が担当する。
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
  // 今日より先(未来)へは進めない。1時間枠モードは最終枠かどうかも見る。
  const nextBlocked = fullDay ? day >= today : atLast && day >= today;

  // 別の日付の指定枠(1時間枠 or "day")へ遷移する(矢印の日またぎ・カレンダー選択)。
  // 取得中の連打で二重遷移しないよう、進行中は無視する。
  function navTo(d: string, slot: number | "day") {
    if (isNavigating) return;
    setPinToLatest(false);
    const p = new URLSearchParams();
    p.set("date", d);
    p.set("slot", String(slot));
    if (deviceId) p.set("deviceId", deviceId);
    startNavigation(() => {
      router.push(`/map?${p.toString()}`);
    });
  }

  // ◀: 24時間モードなら前日へ。1時間枠モードは枠内 −1時間、先頭(00:00)なら前日の 23:00 へ。
  function goPrev() {
    if (fullDay) {
      navTo(shiftDay(day, -1), "day");
      return;
    }
    setPinToLatest(false);
    if (slotStartMs > dayStartMs) setSlotStartMs(slotStartMs - SLOT_MS);
    else navTo(shiftDay(day, -1), 23);
  }

  // ▶: 24時間モードなら翌日へ(未来日は不可)。1時間枠モードは枠内 +1時間、末尾なら翌日の 00:00 へ。
  function goNext() {
    if (fullDay) {
      if (day < today) navTo(shiftDay(day, 1), "day");
      return;
    }
    setPinToLatest(false);
    if (!atLast) setSlotStartMs(slotStartMs + SLOT_MS);
    else if (!nextBlocked) navTo(shiftDay(day, 1), 0);
  }

  // 「更新」= 今へ。今日でなければ今日へ遷移、今日なら再取得して最新枠へ。
  // いずれも1時間枠モードに戻す(「最新」は特定の瞬間を見る操作のため)。
  // pinToLatest を立てて、MapView のステッパーを枠の先頭ではなく最終地点に合わせる。
  function onUpdate() {
    if (isNavigating) return;
    setPinToLatest(true);
    setFullDay(false);
    if (day === today) {
      startNavigation(() => {
        router.refresh();
      });
      setSlotStartMs(slotOf(lastMs));
    } else {
      const p = new URLSearchParams();
      p.set("date", today);
      if (deviceId) p.set("deviceId", deviceId);
      startNavigation(() => {
        router.push(`/map?${p.toString()}`);
      });
    }
  }

  return (
    <>
      <div className="relative flex flex-1 flex-col">
        {!apiKey ? (
          <div className="p-6 text-red-600">
            GOOGLE_MAPS_API_KEY が設定されていません。README のセットアップ手順を参照してください。
          </div>
        ) : (
          <MapView
            apiKey={apiKey}
            points={points}
            meta={meta}
            slotStartMs={slotStartMs}
            fullDay={fullDay}
            pinToLatest={pinToLatest}
            onPrevRange={goPrev}
            onNextRange={nextBlocked ? undefined : goNext}
          />
        )}
        {/* 日付/24時間切替のサーバ取得中はここに重ねて表示。クリックが効いているか
            わからない、という不安をなくすため、地図はそのままに前面へ出す。 */}
        {isNavigating ? (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/60 dark:bg-black/50"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3 rounded-lg bg-white px-4 py-3 text-base shadow-lg dark:bg-neutral-900">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600 dark:border-neutral-700" />
              読み込み中…
            </div>
          </div>
        ) : null}
      </div>

      {/* 常時表示の日付/時間帯ナビ: ◀ 日付 時間帯 ▶ 最新。date はネイティブカレンダー。 */}
      <div className="flex items-center gap-3 border-t border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <button
          onClick={goPrev}
          className={`${btn} shrink-0`}
          disabled={isNavigating}
          aria-label={fullDay ? "前日へ" : "1時間前(前日へ繰越)"}
          aria-keyshortcuts="ArrowLeft"
        >
          ◀
        </button>
        <DateInput
          current={day}
          disabled={isNavigating}
          onSelect={(d) => navTo(d, "day")}
        />
        <select
          value={fullDay ? "day" : slotStartMs}
          onChange={(e) => {
            setPinToLatest(false);
            const v = e.target.value;
            if (v === "day") {
              setFullDay(true);
            } else {
              setFullDay(false);
              setSlotStartMs(Number(v));
            }
          }}
          disabled={isNavigating}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-3 text-lg tabular-nums disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900"
          aria-label="時間帯を選択"
        >
          <option value="day">24時間{points.length > 0 ? ` (${points.length})` : ""}</option>
          {Array.from({ length: 24 }, (_, i) => {
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
          disabled={nextBlocked || isNavigating}
          aria-label={fullDay ? "翌日へ" : "1時間後(翌日へ繰越)"}
          aria-keyshortcuts="ArrowRight"
        >
          ▶
        </button>
        <button
          onClick={onUpdate}
          className={`${btn} shrink-0`}
          disabled={isNavigating}
          aria-label="今日の最新へ"
        >
          最新
        </button>
      </div>
    </>
  );
}
