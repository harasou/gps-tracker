"use client";

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

// "HH:mm"(JST)。
function jstHM(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
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
}: {
  apiKey: string;
  points: LocationPoint[];
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObjRef = useRef<google.maps.Map | null>(null);
  const cursorMarkerRef = useRef<google.maps.Marker | null>(null);
  const travelledRef = useRef<google.maps.Polyline | null>(null);
  const [error, setError] = useState<string | null>(null);
  // タイムラインスクラバーの現在位置(点のインデックス)。初期は末尾(最新)。
  const [cursor, setCursor] = useState<number>(points.length - 1);

  const gaps = useMemo(() => detectGaps(points), [points]);

  // 表示対象が変わったらカーソルを末尾へ戻す。
  useEffect(() => {
    setCursor(points.length - 1);
  }, [points]);

  // 地図の初期化。
  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !mapRef.current) return;
        const g = (window as unknown as { google: typeof google }).google;

        const path = points.map((p) => ({ lat: p.lat, lng: p.lng }));
        const last = path[path.length - 1];

        const map = new g.maps.Map(mapRef.current, {
          center: last,
          zoom: 15,
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

        // 全点が収まるように調整。寄りすぎ防止に最大ズームを制限。
        const bounds = new g.maps.LatLngBounds();
        path.forEach((pt) => bounds.extend(pt));
        map.fitBounds(bounds);
        g.maps.event.addListenerOnce(map, "idle", () => {
          const z = map.getZoom();
          if (z !== undefined && z > 17) map.setZoom(17);
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
    const p = points[cursor];
    if (!p) return;
    const pos = { lat: p.lat, lng: p.lng };
    cm.setPosition(pos);
    tr.setPath(points.slice(0, cursor + 1).map((q) => ({ lat: q.lat, lng: q.lng })));
    map.panTo(pos);
  }, [cursor, points]);

  // 「今」: 最新(現在)地点に寄る。カメラのみ動かす(データ・スクラバーは変えない)。
  function zoomToNow() {
    const map = mapObjRef.current;
    if (!map || points.length === 0) return;
    const last = points[points.length - 1];
    map.panTo({ lat: last.lat, lng: last.lng });
    map.setZoom(17);
  }

  // 「全体」: その日の軌跡全体が収まるよう引く(初期表示と同じ fitBounds)。
  function zoomToDay() {
    const map = mapObjRef.current;
    const g = (window as unknown as { google?: typeof google }).google;
    if (!map || !g || points.length === 0) return;
    const bounds = new g.maps.LatLngBounds();
    points.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds);
    // 寄りすぎ防止に最大ズームを制限(初期表示と同じ挙動)。
    g.maps.event.addListenerOnce(map, "idle", () => {
      const z = map.getZoom();
      if (z !== undefined && z > 17) map.setZoom(17);
    });
  }

  if (error) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  const current = points[cursor];

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative flex-1">
        <div ref={mapRef} className="absolute inset-0" />
        {/* 地図上部中央のカメラ操作。今=最新に寄る / 全体=1日全体に引く。 */}
        <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 gap-1">
          <button
            onClick={zoomToNow}
            className="rounded bg-white/95 px-3 py-1.5 text-sm font-medium shadow hover:bg-white dark:bg-neutral-800/95 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            今
          </button>
          <button
            onClick={zoomToDay}
            className="rounded bg-white/95 px-3 py-1.5 text-sm font-medium shadow hover:bg-white dark:bg-neutral-800/95 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            全体
          </button>
        </div>
      </div>
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 font-medium tabular-nums">
            🕐 {current ? jstTime(current.recordedAt) : "--:--:--"}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, points.length - 1)}
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
            className="flex-1 accent-red-600"
            aria-label="時間スクラバー"
          />
          <span className="w-20 shrink-0 text-right tabular-nums text-neutral-500">
            {points.length ? cursor + 1 : 0} / {points.length}
          </span>
        </div>

        {gaps.length > 0 ? (
          <div className="mt-2">
            <div className="text-xs font-medium text-red-600">
              🕳 記録なしの時間帯: {gaps.length} 件（赤い点線の区間）
            </div>
            <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
              {gaps.map((gp, i) => (
                <button
                  key={i}
                  onClick={() => setCursor(gp.toIdx)}
                  className="shrink-0 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs tabular-nums text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
                  title="この時刻(記録再開点)へ移動"
                >
                  {jstHM(gp.fromTime)} → {jstHM(gp.toTime)}（{fmtDuration(gp.ms)}）
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-neutral-400">
            スライダーを動かすと、その時刻の位置(赤)と通過済みの軌跡が強調表示されます。記録なしの時間帯はありません。
          </p>
        )}
      </div>
    </div>
  );
}
