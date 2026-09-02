"use client";

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LocationPoint } from "@/lib/types";

// 選択できる時間枠(30分)。
export const SLOT_MS = 30 * 60 * 1000;
const DAY_MS = 86_400_000;

// Google Maps JS API を 1 度だけ読み込むためのローダ。
let mapsPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if ((window as unknown as { google?: { maps?: unknown } }).google?.maps) {
    return Promise.resolve();
  }
  if (mapsPromise) return mapsPromise;

  mapsPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey,
    )}&v=weekly`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Maps の読み込みに失敗しました"));
    document.head.appendChild(script);
  });
  return mapsPromise;
}

// ISO8601(UTC) を JST の "HH:mm:ss" に整形。
function jstTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

// epoch ms を JST の "HH:mm" に整形。
function jstHMms(ms: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

// 記録が飛んでいる区間(前後の点の時間差が通常より大きい)。日次サマリ用。
interface Gap {
  fromIdx: number;
  toIdx: number;
  ms: number;
}

// 連続2点の時間差が「中央値×3」かつ「最低3分」を超えたら記録なしとみなす。
function detectGaps(points: LocationPoint[]): Gap[] {
  if (points.length < 3) return [];
  const times = points.map((p) => Date.parse(p.recordedAt));
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 60000;
  const threshold = Math.max(median * 3, 180_000);

  const gaps: Gap[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > threshold) gaps.push({ fromIdx: i - 1, toIdx: i, ms: d });
  }
  return gaps;
}

function popupHtml(p: LocationPoint, index: number, total: number): string {
  const acc = p.accuracy !== undefined ? `<br>精度 約${Math.round(p.accuracy)}m` : "";
  return `<div style="font-size:12px;line-height:1.5">🕐 <b>${jstTime(
    p.recordedAt,
  )}</b>（JST）<br>${index + 1} / ${total} 点目${acc}</div>`;
}

// 下部の詳細パネルに出すサーバ集計値。
export interface MapMeta {
  noFixCount: number;
  excludedByAccuracy: number;
  excludedBySpeed: number;
  excludedBySpike: number;
  excludedTotal: number;
  excludedPct: number;
  rangeLabel: string;
  deviceId?: string;
}

export default function MapView({
  apiKey,
  points,
  meta,
  day,
}: {
  apiKey: string;
  points: LocationPoint[];
  meta: MapMeta;
  // 表示中の JST 暦日 "YYYY-MM-DD"。30 分枠の基準(その日の 00:00)に使う。
  day: string;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObjRef = useRef<google.maps.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 現在描画中のオーバーレイ(枠切替のたびに消して描き直す)。
  const plotRef = useRef<{
    overlays: (google.maps.Polyline | google.maps.Marker)[];
    info: google.maps.InfoWindow | null;
  }>({ overlays: [], info: null });
  // 下部の詳細パネル。既定は閉じ、ハンドルの上スワイプ/タップで開く。
  const [detailsOpen, setDetailsOpen] = useState(false);
  const swipeRef = useRef(0);

  const gaps = useMemo(() => detectGaps(points), [points]);

  // その日の 00:00(JST) と 各点時刻。
  const dayStartMs = useMemo(() => Date.parse(`${day}T00:00:00+09:00`), [day]);
  const lastMs = points.length ? Date.parse(points[points.length - 1].recordedAt) : dayStartMs;
  // ある時刻が属する 30 分枠の開始 ms。
  const slotOf = (ms: number) =>
    dayStartMs + Math.floor((ms - dayStartMs) / SLOT_MS) * SLOT_MS;

  // 選択中の 30 分枠(開始 ms)。初期は最新点の枠。
  const [slotStartMs, setSlotStartMs] = useState<number>(slotOf(lastMs));

  // 表示対象(日)が変わったら最新枠へ戻す。
  useEffect(() => {
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

  // 選択中の 30 分枠に入る点だけ。
  const windowPoints = useMemo(
    () =>
      points.filter((p) => {
        const t = Date.parse(p.recordedAt);
        return t >= slotStartMs && t < slotStartMs + SLOT_MS;
      }),
    [points, slotStartMs],
  );

  // 地図は一度だけ生成する(枠切替では作り直さない)。
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !mapRef.current) return;
        const g = (window as unknown as { google: typeof google }).google;
        const center = points.length
          ? { lat: points[points.length - 1].lat, lng: points[points.length - 1].lng }
          : { lat: 35.681, lng: 139.767 };
        const map = new g.maps.Map(mapRef.current, {
          center,
          zoom: 15,
          mapTypeControl: true,
          streetViewControl: false,
        });
        mapObjRef.current = map;
        plotRef.current.info = new g.maps.InfoWindow();
        setMapReady(true);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // 地図生成は一度きり。points は初期センターにのみ使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // 選択中の 30 分枠の点だけを描画し、その範囲にフィットする。
  useEffect(() => {
    if (!mapReady) return;
    const map = mapObjRef.current;
    const g = (window as unknown as { google?: typeof google }).google;
    if (!map || !g) return;
    const info = plotRef.current.info;

    // 既存オーバーレイを消す。
    plotRef.current.overlays.forEach((o) => o.setMap(null));
    plotRef.current.overlays = [];
    if (windowPoints.length === 0) return;

    // 3 分超の切れ目で run に分割(ギャップをまたぐ線は引かない)。
    const runs: LocationPoint[][] = [];
    let cur: LocationPoint[] = [];
    for (let i = 0; i < windowPoints.length; i++) {
      if (
        i > 0 &&
        Date.parse(windowPoints[i].recordedAt) - Date.parse(windowPoints[i - 1].recordedAt) >
          180_000
      ) {
        runs.push(cur);
        cur = [];
      }
      cur.push(windowPoints[i]);
    }
    if (cur.length) runs.push(cur);

    runs.forEach((run) => {
      if (run.length < 2) return;
      const line = new g.maps.Polyline({
        path: run.map((p) => ({ lat: p.lat, lng: p.lng })),
        geodesic: true,
        strokeColor: "#2563eb",
        strokeOpacity: 0.9,
        strokeWeight: 4,
        map,
      });
      plotRef.current.overlays.push(line);
    });

    windowPoints.forEach((p, i) => {
      const marker = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 4,
          fillColor: "#2563eb",
          fillOpacity: 0.9,
          strokeColor: "#ffffff",
          strokeWeight: 1,
        },
        title: `${jstTime(p.recordedAt)}（JST）`,
      });
      marker.addListener("click", () => {
        if (!info) return;
        info.setContent(popupHtml(p, i, windowPoints.length));
        info.open({ map, anchor: marker });
      });
      plotRef.current.overlays.push(marker);
    });

    // 枠の点が収まるようにフィット(寄りすぎ防止に最大ズームを制限)。
    const bounds = new g.maps.LatLngBounds();
    windowPoints.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds);
    g.maps.event.addListenerOnce(map, "idle", () => {
      const z = map.getZoom();
      if (z !== undefined && z > 17) map.setZoom(17);
    });
  }, [mapReady, windowPoints]);

  // 詳細パネルのハンドル。上スワイプで開く/下スワイプで閉じる/小さい動き(タップ)はトグル。
  function onHandleDown(e: React.PointerEvent<HTMLDivElement>) {
    swipeRef.current = e.clientY;
  }
  function onHandleUp(e: React.PointerEvent<HTMLDivElement>) {
    const dy = e.clientY - swipeRef.current;
    if (dy < -15) setDetailsOpen(true);
    else if (dy > 15) setDetailsOpen(false);
    else setDetailsOpen((o) => !o);
  }

  if (error) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  const btn =
    "rounded border border-neutral-300 px-2 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-neutral-700 dark:hover:bg-neutral-800";
  const atFirst = slotStartMs <= dayStartMs;
  const atLast = slotStartMs >= dayStartMs + DAY_MS - SLOT_MS;

  return (
    <div className="flex flex-1 flex-col">
      <div ref={mapRef} className="flex-1" />
      <div className="border-t border-neutral-200 px-4 pb-3 pt-2 dark:border-neutral-800">
        {/* 時間ナビ(30分枠)。更新=最新枠へ / ← → で ±30分 / ドロップダウンで選択。 */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSlotStartMs(slotOf(lastMs))}
            className={btn}
            aria-label="最新の時間帯へ"
          >
            更新
          </button>
          <button
            onClick={() => setSlotStartMs(Math.max(dayStartMs, slotStartMs - SLOT_MS))}
            className={btn}
            disabled={atFirst}
            aria-label="30分前"
          >
            ◀
          </button>
          <select
            value={slotStartMs}
            onChange={(e) => setSlotStartMs(Number(e.target.value))}
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
            aria-label="時間帯(30分)を選択"
          >
            {Array.from({ length: 48 }, (_, i) => {
              const ms = dayStartMs + i * SLOT_MS;
              const n = slotCounts.get(i) ?? 0;
              return (
                <option key={i} value={ms}>
                  {jstHMms(ms)}–{jstHMms(ms + SLOT_MS)}
                  {n > 0 ? ` (${n})` : ""}
                </option>
              );
            })}
          </select>
          <button
            onClick={() =>
              setSlotStartMs(Math.min(dayStartMs + DAY_MS - SLOT_MS, slotStartMs + SLOT_MS))
            }
            className={btn}
            disabled={atLast}
            aria-label="30分後"
          >
            ▶
          </button>
        </div>

        {/* 上スワイプ/タップで開く詳細ハンドル。 */}
        <div
          onPointerDown={onHandleDown}
          onPointerUp={onHandleUp}
          className="mt-2 flex touch-none cursor-pointer select-none flex-col items-center gap-1"
          role="button"
          aria-expanded={detailsOpen}
          aria-label="詳細の開閉"
        >
          <div className="h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600" />
          <div className="text-xs text-neutral-500 tabular-nums">
            {detailsOpen
              ? "▼ 詳細を閉じる"
              : `▲ この30分 ${windowPoints.length}点 · 全${points.length}点 · 除外${meta.excludedTotal}`}
          </div>
        </div>

        {/* 詳細パネル(日次: 点数・除外内訳・位置不明・日付・device)。 */}
        {detailsOpen ? (
          <div className="mt-1 space-y-0.5 rounded bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
            <div className="tabular-nums">
              {points.length} 点
              {meta.noFixCount > 0 ? ` / 位置不明 ${meta.noFixCount} 件` : ""}
            </div>
            {meta.excludedTotal > 0 ? (
              <div className="tabular-nums">
                除外 {meta.excludedTotal} 点 ({meta.excludedPct}%: 精度
                {meta.excludedByAccuracy} / 速度{meta.excludedBySpeed} / スパイク
                {meta.excludedBySpike})
              </div>
            ) : null}
            <div className="tabular-nums">未取得の時間帯: {gaps.length} 件</div>
            <div>
              {meta.rangeLabel}
              {meta.deviceId ? ` / device: ${meta.deviceId}` : ""}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
