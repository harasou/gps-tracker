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

// クリックした点が「何番目 / 全体」かも出す。
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
  const [error, setError] = useState<string | null>(null);

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

        // 軌跡を線で描く
        new g.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: "#2563eb",
          strokeOpacity: 0.7,
          strokeWeight: 3,
          map,
        });

        // クリックで時刻を出す共有 InfoWindow
        const info = new g.maps.InfoWindow();

        // 各点を小さな丸マーカーにして、クリックで時刻(JST)を表示。
        // 点が多すぎると重いので、最大 800 個に間引く(間引いても時刻は分かる)。
        const MAX_MARKERS = 800;
        const step = Math.max(1, Math.ceil(points.length / MAX_MARKERS));
        for (let i = 0; i < points.length; i += step) {
          const p = points[i];
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
            info.setContent(popupHtml(p, i, points.length));
            info.open({ map, anchor: marker });
          });
        }

        // 始点(S)・終点(E)は大きめのピンで、クリックで時刻表示。
        const makePin = (
          p: LocationPoint,
          index: number,
          label: string,
        ) => {
          const pin = new g.maps.Marker({
            position: { lat: p.lat, lng: p.lng },
            map,
            title: `${label === "S" ? "始点" : "終点"} ${jstTime(p.recordedAt)}（JST）`,
            label,
            zIndex: 1000,
          });
          pin.addListener("click", () => {
            info.setContent(popupHtml(p, index, points.length));
            info.open({ map, anchor: pin });
          });
        };
        makePin(points[0], 0, "S");
        makePin(points[points.length - 1], points.length - 1, "E");

        // 全点が収まるように表示範囲を調整。ただし寄りすぎ防止に最大ズームを制限。
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

  if (error) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  return <div ref={mapRef} className="flex-1" />;
}
