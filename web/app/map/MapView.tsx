"use client";

import { useEffect, useRef, useState } from "react";
import type { LocationPoint } from "@/lib/types";

// Google Maps JS API を 1 度だけ読み込むためのローダ。
// 複数コンポーネントから呼ばれても script は 1 つに保つ。
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
          strokeOpacity: 0.9,
          strokeWeight: 4,
          map,
        });

        // 始点(緑)・終点(赤)にマーカー
        new g.maps.Marker({
          position: path[0],
          map,
          title: `始点: ${points[0].recordedAt}`,
          label: "S",
        });
        new g.maps.Marker({
          position: last,
          map,
          title: `終点: ${points[points.length - 1].recordedAt}`,
          label: "E",
        });

        // 全点が収まるように表示範囲を調整
        const bounds = new g.maps.LatLngBounds();
        path.forEach((pt) => bounds.extend(pt));
        map.fitBounds(bounds);
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
