"use client";

import { useEffect, useRef, useState } from "react";
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
  const gRef = useRef<typeof google | null>(null);
  const mapObjRef = useRef<google.maps.Map | null>(null);
  const cursorMarkerRef = useRef<google.maps.Marker | null>(null);
  const travelledRef = useRef<google.maps.Polyline | null>(null);
  const [error, setError] = useState<string | null>(null);
  // タイムラインスクラバーの現在位置(点のインデックス)。初期は末尾(最新)。
  const [cursor, setCursor] = useState<number>(points.length - 1);

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
        gRef.current = g;

        const path = points.map((p) => ({ lat: p.lat, lng: p.lng }));
        const last = path[path.length - 1];

        const map = new g.maps.Map(mapRef.current, {
          center: last,
          zoom: 15,
          mapTypeControl: true,
          streetViewControl: false,
        });
        mapObjRef.current = map;

        // 全体の軌跡(薄い青)。未通過ぶんの下地になる。
        new g.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: "#93c5fd",
          strokeOpacity: 0.9,
          strokeWeight: 3,
          map,
        });

        // 通過済みの軌跡(濃い青)。スクラバーで長さが変わる。初期は全区間。
        travelledRef.current = new g.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: "#2563eb",
          strokeOpacity: 0.9,
          strokeWeight: 4,
          map,
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
  }, [apiKey, points]);

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

  if (error) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  const current = points[cursor];

  return (
    <div className="flex flex-1 flex-col">
      <div ref={mapRef} className="flex-1" />
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
        <p className="mt-1 text-xs text-neutral-400">
          スライダーを動かすと、その時刻の位置(赤)と通過済みの軌跡が強調表示されます。
        </p>
      </div>
    </div>
  );
}
