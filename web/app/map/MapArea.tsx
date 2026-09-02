"use client";

import type { LocationPoint } from "@/lib/types";
import MapView, { type MapMeta } from "./MapView";
import DateInput from "./DateInput";

// 日付ナビと地図をまとめる。時間帯(30分)の選択・地図描画は MapView 側が持つ。
export default function MapArea({
  apiKey,
  points,
  day,
  deviceId,
  prevHref,
  nextHref,
  meta,
}: {
  apiKey: string;
  points: LocationPoint[];
  day: string;
  deviceId?: string;
  prevHref: string;
  nextHref: string;
  meta: MapMeta;
}) {
  const btn =
    "rounded border border-neutral-300 px-2 py-1.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800";

  return (
    <>
      {/* 日付ナビ。date 入力はネイティブのカレンダー(今日も選べる)。 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800">
        <a href={prevHref} className={btn} aria-label="前日">
          ◀ 前日
        </a>
        <DateInput current={day} deviceId={deviceId} />
        <a href={nextHref} className={btn} aria-label="翌日">
          翌日 ▶
        </a>
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
        <MapView apiKey={apiKey} points={points} meta={meta} day={day} />
      )}
    </>
  );
}
