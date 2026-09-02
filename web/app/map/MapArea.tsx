"use client";

import { useRef } from "react";
import type { LocationPoint } from "@/lib/types";
import MapView from "./MapView";
import DateInput from "./DateInput";

// 日付ナビと地図をまとめる。地図オブジェクトをここで保持し、
// 日付行に置いた「最新」「全体」ボタンから地図のカメラを操作する。
export default function MapArea({
  apiKey,
  points,
  day,
  deviceId,
  prevHref,
  nextHref,
}: {
  apiKey: string;
  points: LocationPoint[];
  day: string;
  deviceId?: string;
  prevHref: string;
  nextHref: string;
}) {
  const mapObjRef = useRef<google.maps.Map | null>(null);
  const hasMap = Boolean(apiKey) && points.length > 0;

  const btn =
    "rounded border border-neutral-300 px-2 py-1.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800";

  // 「最新」: 最新地点に寄る。
  function zoomToNow() {
    const map = mapObjRef.current;
    if (!map || points.length === 0) return;
    const last = points[points.length - 1];
    map.panTo({ lat: last.lat, lng: last.lng });
    map.setZoom(17);
  }

  // 「全体」: その日の軌跡全体が収まるよう引く。
  function zoomToDay() {
    const map = mapObjRef.current;
    const g = (window as unknown as { google?: typeof google }).google;
    if (!map || !g || points.length === 0) return;
    const bounds = new g.maps.LatLngBounds();
    points.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds);
    // 寄りすぎ防止に最大ズームを制限。
    g.maps.event.addListenerOnce(map, "idle", () => {
      const z = map.getZoom();
      if (z !== undefined && z > 17) map.setZoom(17);
    });
  }

  return (
    <>
      {/* 日付ナビ + カメラ操作。date 入力はネイティブのカレンダー(今日も選べる)。 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800">
        <a href={prevHref} className={btn} aria-label="前日">
          ◀ 前日
        </a>
        <DateInput current={day} deviceId={deviceId} />
        <a href={nextHref} className={btn} aria-label="翌日">
          翌日 ▶
        </a>
        {hasMap ? (
          <div className="ml-auto flex gap-2">
            <button onClick={zoomToNow} className={btn}>
              最新
            </button>
            <button onClick={zoomToDay} className={btn}>
              全体
            </button>
          </div>
        ) : null}
      </div>

      {!apiKey ? (
        <div className="p-6 text-red-600">
          GOOGLE_MAPS_API_KEY が設定されていません。README のセットアップ手順を参照してください。
        </div>
      ) : points.length === 0 ? (
        <div className="p-6 text-neutral-500">
          この日の位置情報がありません。日付を変えるか「全期間」で直近を表示してください。
        </div>
      ) : (
        <MapView apiKey={apiKey} points={points} mapObjRef={mapObjRef} />
      )}
    </>
  );
}
