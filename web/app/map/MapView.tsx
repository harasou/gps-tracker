"use client";

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LocationPoint } from "@/lib/types";

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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// epoch ms を JST の "HH:mm" に整形。
function jstHMms(ms: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

// その時刻が属する JST 暦日の 00:00(epoch ms)。日バーの左端に使う。
function jstDayStartMs(iso: string): number {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return Date.parse(`${ymd}T00:00:00+09:00`);
}

// 記録が飛んでいる区間(前後の点の時間差が通常より大きい)。
interface Gap {
  fromIdx: number;
  toIdx: number;
  ms: number;
  fromTime: string;
  toTime: string;
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
    if (d > threshold) {
      gaps.push({
        fromIdx: i - 1,
        toIdx: i,
        ms: d,
        fromTime: points[i - 1].recordedAt,
        toTime: points[i].recordedAt,
      });
    }
  }
  return gaps;
}

function popupHtml(p: LocationPoint, index: number, total: number): string {
  const acc = p.accuracy !== undefined ? `<br>精度 約${Math.round(p.accuracy)}m` : "";
  return `<div style="font-size:12px;line-height:1.5">🕐 <b>${jstTime(
    p.recordedAt,
  )}</b>（JST）<br>${index + 1} / ${total} 点目${acc}</div>`;
}

export default function MapView({
  apiKey,
  points,
  mapObjRef,
}: {
  apiKey: string;
  points: LocationPoint[];
  // 地図オブジェクトは親(MapArea)と共有し、ヘッダーの「最新」「全体」ボタンから操作する。
  mapObjRef: React.MutableRefObject<google.maps.Map | null>;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const cursorMarkerRef = useRef<google.maps.Marker | null>(null);
  const travelledRef = useRef<google.maps.Polyline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // 窓ドラッグの一時状態(再描画を挟まないので ref に持つ)。
  const dragRef = useRef({ active: false, startX: 0, startWin: 0, moved: false });

  const gaps = useMemo(() => detectGaps(points), [points]);

  // 日バーの範囲(その日の JST 00:00〜翌 00:00)。
  const dayStartMs = useMemo(
    () => (points.length ? jstDayStartMs(points[0].recordedAt) : 0),
    [points],
  );
  const dayEndMs = dayStartMs + DAY_MS;
  const lastMs = points.length ? Date.parse(points[points.length - 1].recordedAt) : dayStartMs;

  // スクラバーの現在時刻(ms)と、1時間窓の開始時刻(ms)。初期は最新点。
  const [cursorMs, setCursorMs] = useState<number>(lastMs);
  const [winStartMs, setWinStartMs] = useState<number>(
    clamp(lastMs - HOUR_MS / 2, dayStartMs, dayEndMs - HOUR_MS),
  );

  // 表示対象が変わったら最新へ戻す。
  useEffect(() => {
    setCursorMs(lastMs);
    setWinStartMs(clamp(lastMs - HOUR_MS / 2, dayStartMs, dayEndMs - HOUR_MS));
  }, [points, lastMs, dayStartMs, dayEndMs]);

  // cursorMs に最も近い点の index(地図の赤マーカー・通過済み軌跡が指す点)。
  const cursorIdx = useMemo(() => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(Date.parse(points[i].recordedAt) - cursorMs);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }, [points, cursorMs]);

  // 日バーに描く「取得あり」区間(青)。連続点の時間差がしきい値以下を採用し、
  // 隣接する採用区間はつなげる。残り(=未取得)は背景の赤い縦線で見える。
  const covered = useMemo(() => {
    const t = points.map((p) => Date.parse(p.recordedAt));
    if (t.length < 2) return [] as { s: number; e: number }[];
    const deltas: number[] = [];
    for (let i = 1; i < t.length; i++) deltas.push(t[i] - t[i - 1]);
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 60_000;
    const threshold = Math.max(median * 3, 180_000);
    const segs: { s: number; e: number }[] = [];
    for (let i = 1; i < t.length; i++) {
      if (t[i] - t[i - 1] <= threshold) {
        const prev = segs[segs.length - 1];
        if (prev && prev.e === t[i - 1]) prev.e = t[i];
        else segs.push({ s: t[i - 1], e: t[i] });
      }
    }
    return segs;
  }, [points]);

  // ms → バー上の左端からの % 位置。
  const pct = (ms: number) => clamp(((ms - dayStartMs) / DAY_MS) * 100, 0, 100);

  // 地図の初期化。
  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !mapRef.current) return;
        const g = (window as unknown as { google: typeof google }).google;

        const path = points.map((p) => ({ lat: p.lat, lng: p.lng }));
        const last = path[path.length - 1];

        // 初期状態は「今」(最新地点に寄る)。全体表示は「全体」ボタンで。
        const map = new g.maps.Map(mapRef.current, {
          center: last,
          zoom: 17,
          mapTypeControl: true,
          streetViewControl: false,
        });
        mapObjRef.current = map;

        // 全体の軌跡(薄い青)。
        new g.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: "#93c5fd",
          strokeOpacity: 0.9,
          strokeWeight: 3,
          map,
        });

        // 通過済みの軌跡(濃い青)。スクラバーで長さが変わる。
        travelledRef.current = new g.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: "#2563eb",
          strokeOpacity: 0.9,
          strokeWeight: 4,
          map,
        });

        // 記録なし区間を赤い点線で結ぶ(この間の経路は不明)。
        gaps.forEach((gp) => {
          new g.maps.Polyline({
            path: [
              { lat: points[gp.fromIdx].lat, lng: points[gp.fromIdx].lng },
              { lat: points[gp.toIdx].lat, lng: points[gp.toIdx].lng },
            ],
            strokeOpacity: 0,
            icons: [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeOpacity: 1,
                  strokeColor: "#dc2626",
                  scale: 3,
                },
                offset: "0",
                repeat: "12px",
              },
            ],
            zIndex: 5,
            map,
          });
        });

        // 各点の丸マーカー(クリックで時刻)。多い場合は最大800個に間引く。
        const info = new g.maps.InfoWindow();
        const MAX_MARKERS = 800;
        const step = Math.max(1, Math.ceil(points.length / MAX_MARKERS));
        for (let i = 0; i < points.length; i += step) {
          const p = points[i];
          const marker = new g.maps.Marker({
            position: { lat: p.lat, lng: p.lng },
            map,
            icon: {
              path: g.maps.SymbolPath.CIRCLE,
              scale: 3.5,
              fillColor: "#2563eb",
              fillOpacity: 0.8,
              strokeColor: "#ffffff",
              strokeWeight: 1,
            },
            title: `${jstTime(p.recordedAt)}（JST）`,
          });
          marker.addListener("click", () => {
            info.setContent(popupHtml(p, i, points.length));
            info.open({ map, anchor: marker });
          });
        }

        // スクラバーの現在位置を示す赤い大きめマーカー。
        cursorMarkerRef.current = new g.maps.Marker({
          position: last,
          map,
          zIndex: 2000,
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: "#dc2626",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
          },
        });

      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, points, gaps]);

  // スクラバー移動時に、赤マーカーと通過済み軌跡を更新する。
  useEffect(() => {
    const map = mapObjRef.current;
    const cm = cursorMarkerRef.current;
    const tr = travelledRef.current;
    if (!map || !cm || !tr) return;
    const p = points[cursorIdx];
    if (!p) return;
    const pos = { lat: p.lat, lng: p.lng };
    cm.setPosition(pos);
    tr.setPath(points.slice(0, cursorIdx + 1).map((q) => ({ lat: q.lat, lng: q.lng })));
    map.panTo(pos);
  }, [cursorIdx, points]);

  // clientX → その位置の時刻(ms)。
  function timeAtX(clientX: number): number {
    const el = barRef.current;
    if (!el) return dayStartMs;
    const r = el.getBoundingClientRect();
    return dayStartMs + clamp((clientX - r.left) / r.width, 0, 1) * DAY_MS;
  }

  // 日バー上の操作。窓の上=ドラッグで窓移動/クリックでカーソル、窓の外=そこへ窓とカーソルを移動。
  function onBarPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const t = timeAtX(e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (t >= winStartMs && t <= winStartMs + HOUR_MS) {
      dragRef.current = { active: true, startX: e.clientX, startWin: winStartMs, moved: false };
    } else {
      const ns = clamp(t - HOUR_MS / 2, dayStartMs, dayEndMs - HOUR_MS);
      setWinStartMs(ns);
      setCursorMs(clamp(t, ns, ns + HOUR_MS));
    }
  }

  function onBarPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d.active) return;
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
    if (!d.moved) return;
    const el = barRef.current;
    if (!el) return;
    const deltaMs = ((e.clientX - d.startX) / el.getBoundingClientRect().width) * DAY_MS;
    const ns = clamp(d.startWin + deltaMs, dayStartMs, dayEndMs - HOUR_MS);
    setWinStartMs(ns);
    setCursorMs((c) => clamp(c, ns, ns + HOUR_MS));
  }

  function onBarPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    // ドラッグせずに窓の上を離した=クリック → その位置へカーソル。
    if (d.active && !d.moved) setCursorMs(timeAtX(e.clientX));
    dragRef.current = { active: false, startX: 0, startWin: 0, moved: false };
  }

  if (error) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  const current = points[cursorIdx];

  return (
    <div className="flex flex-1 flex-col">
      <div ref={mapRef} className="flex-1" />
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="mb-2 flex items-center gap-3 text-sm">
          <span className="font-medium tabular-nums">
            🕐 {current ? jstTime(current.recordedAt) : "--:--:--"}
          </span>
          <span className="tabular-nums text-neutral-500">
            窓 {jstHMms(winStartMs)}–{jstHMms(winStartMs + HOUR_MS)}
          </span>
          <span className="ml-auto tabular-nums text-neutral-500">
            {points.length ? cursorIdx + 1 : 0} / {points.length}
          </span>
        </div>

        {/* 1日分(00–24h)のバー。背景の赤い縦線=未取得、青=取得あり、赤枠=1時間窓、赤線=現在位置。 */}
        <div
          ref={barRef}
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
          className="relative h-9 w-full touch-none select-none overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800"
          role="slider"
          aria-label="時間スクラバー(1日分)"
          aria-valuetext={current ? jstTime(current.recordedAt) : undefined}
        >
          {/* 未取得を表す赤い縦線パターン(全域)。青区間で覆われた所は取得あり。 */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, rgba(220,38,38,0.35) 0 1px, transparent 1px 7px)",
            }}
          />
          {/* 取得あり区間(青)。 */}
          {covered.map((c, i) => (
            <div
              key={i}
              className="pointer-events-none absolute top-1 bottom-1 rounded-sm bg-blue-500/80"
              style={{ left: `${pct(c.s)}%`, width: `${Math.max(pct(c.e) - pct(c.s), 0.3)}%` }}
            />
          ))}
          {/* 3時間ごとの目盛。 */}
          {[3, 6, 9, 12, 15, 18, 21].map((h) => (
            <div
              key={h}
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-neutral-300/70 dark:bg-neutral-600/70"
              style={{ left: `${(h / 24) * 100}%` }}
            />
          ))}
          {/* 1時間窓(ドラッグで移動)。 */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 rounded border-2 border-red-500/80 bg-red-500/10"
            style={{ left: `${pct(winStartMs)}%`, width: `${(HOUR_MS / DAY_MS) * 100}%` }}
          />
          {/* 現在位置(カーソル)。 */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 -translate-x-1/2 bg-red-600"
            style={{ left: `${pct(cursorMs)}%` }}
          />
        </div>

        {/* 時刻ラベル。 */}
        <div className="relative mt-1 h-4 text-[10px] text-neutral-400">
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
            <span
              key={h}
              className="absolute -translate-x-1/2 tabular-nums"
              style={{ left: `${(h / 24) * 100}%` }}
            >
              {h}
            </span>
          ))}
        </div>

        {/* 選択中の1時間を全幅で微調整。スマホでも指で分単位に狙える。 */}
        <div className="mt-2 flex items-center gap-2 text-xs tabular-nums text-neutral-500">
          <span className="w-11 shrink-0">{jstHMms(winStartMs)}</span>
          <input
            type="range"
            min={winStartMs}
            max={winStartMs + HOUR_MS}
            step={30_000}
            value={clamp(cursorMs, winStartMs, winStartMs + HOUR_MS)}
            onChange={(e) => setCursorMs(Number(e.target.value))}
            className="h-2 flex-1 accent-red-600"
            aria-label="選択中の1時間の微調整"
          />
          <span className="w-11 shrink-0 text-right">{jstHMms(winStartMs + HOUR_MS)}</span>
        </div>

        <p className="mt-1 text-xs text-neutral-400">
          上のバーをタップ/ドラッグで1時間窓を移動、下のスライダーで窓内の現在位置(赤線)を微調整。赤い縦線＝未取得の時間帯。
        </p>
      </div>
    </div>
  );
}
