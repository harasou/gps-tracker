"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LocationPoint } from "@/lib/types";

// 選択できる時間枠(1時間)。
export const SLOT_MS = 60 * 60 * 1000;
export const DAY_MS = 86_400_000;

// 24時間表示で生成する丸マーカーの上限。超える分は間引く(折れ線は全点描く)。
const MAX_FULLDAY_MARKERS = 300;

// ステッパの自動再生: 現在位置から残りの点を最大40点に間引き、0.25秒間隔で辿る
// (先頭から再生すれば合計およそ10秒)。点と点の間はワープさせず連続的に動かす
// ので、間隔を細かくするほど滑らかに見える。
const PLAY_STEPS = 40;
const PLAY_LEG_MS = 250;

// windowPoints から再生用に最大 PLAY_STEPS 個を均等に間引いたインデックス列を返す。
// 点数が PLAY_STEPS 以下ならそのまま全点を使う。
function samplePlayIndices(total: number, steps: number): number[] {
  if (total <= 0) return [];
  if (total <= steps) return Array.from({ length: total }, (_, i) => i);
  const idx: number[] = [];
  for (let i = 0; i < steps; i++) {
    idx.push(Math.round((i * (total - 1)) / (steps - 1)));
  }
  return idx;
}

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
export function jstHMms(ms: number): string {
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
  return `<div style="font-size:16px;line-height:1.5">🕐 <b>${jstTime(
    p.recordedAt,
  )}</b><br>${index + 1} / ${total} 点目${acc}</div>`;
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

// フォーム部品にフォーカス中は、その部品のネイティブなキー操作(日付欄内の移動、
// select/range のキー操作など)を優先し、グローバルの矢印キー処理はスキップする。
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target.isContentEditable;
}

export default function MapView({
  apiKey,
  points,
  meta,
  slotStartMs,
  fullDay,
  pinToLatest,
  onPrevRange,
  onNextRange,
}: {
  apiKey: string;
  points: LocationPoint[];
  meta: MapMeta;
  // 表示する 1 時間枠の開始時刻(epoch ms)。選択は親(MapArea)が持つ。
  slotStartMs: number;
  // true なら 1 時間枠を無視してその日の全点を表示する。
  fullDay: boolean;
  // 「最新」ボタンで表示中かどうか。true の間、枠が変わってもステッパーは
  // 先頭ではなく最終地点(最新の点)に合わせる。
  pinToLatest: boolean;
  // ◀/▶ による表示範囲(日付/1時間枠)の変更。矢印キー操作から呼ぶ。
  onPrevRange?: () => void;
  onNextRange?: () => void;
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
  // 下部の操作パネル。既定は1行サマリーだけ、タップで展開する。
  const [expanded, setExpanded] = useState(false);
  // 枠内プロットを1点ずつ辿るステッパ。現在位置と、その点を示す赤マーカー/吹き出し。
  const [pointIdx, setPointIdx] = useState(0);
  // 自動再生中かどうかと、そのアニメーションフレームID(停止・枠切替・アンマウント時に破棄する)。
  const [isPlaying, setIsPlaying] = useState(false);
  const playAnimRef = useRef<number | null>(null);
  // 再生アニメーション中、いま画面上で最も近い実データ点のインデックス。
  // 停止時にスライダーをこの点へスナップさせるために都度更新する。
  const playNearestIdxRef = useRef(0);
  const currentMarkerRef = useRef<google.maps.Marker | null>(null);
  const stepInfoRef = useRef<google.maps.InfoWindow | null>(null);
  // 直前に描画した枠。枠切替(=全体フィット)とステップ移動を区別するのに使う。
  const prevWindowRef = useRef<LocationPoint[] | null>(null);

  const gaps = useMemo(() => detectGaps(points), [points]);

  // 24時間表示なら全点、そうでなければ選択中の 1 時間枠に入る点だけ。
  const windowPoints = useMemo(
    () =>
      fullDay
        ? points
        : points.filter((p) => {
            const t = Date.parse(p.recordedAt);
            return t >= slotStartMs && t < slotStartMs + SLOT_MS;
          }),
    [points, slotStartMs, fullDay],
  );

  // 枠が変わったらステッパを先頭(pinToLatest 中は最終地点)へ戻し、再生中なら止める。
  useEffect(() => {
    if (playAnimRef.current !== null) {
      cancelAnimationFrame(playAnimRef.current);
      playAnimRef.current = null;
      setIsPlaying(false);
    }
    setPointIdx(pinToLatest ? Math.max(0, windowPoints.length - 1) : 0);
  }, [windowPoints, pinToLatest]);
  const stepIdx = windowPoints.length ? Math.min(pointIdx, windowPoints.length - 1) : 0;

  // アンマウント時に再生アニメーションを破棄する。
  useEffect(() => {
    return () => {
      if (playAnimRef.current !== null) cancelAnimationFrame(playAnimRef.current);
    };
  }, []);

  // 自動再生の停止。手動でステッパを操作したときにも呼ぶ。
  // 再生中に止めた場合は、今画面に見えている位置に最も近い実データ点へ
  // スライダーをスナップさせる(直前に通過した点のまま止まって見えないように)。
  function stopPlay() {
    if (playAnimRef.current !== null) {
      cancelAnimationFrame(playAnimRef.current);
      playAnimRef.current = null;
      setPointIdx(playNearestIdxRef.current);
    }
    setIsPlaying(false);
  }

  // 自動再生の開始/停止トグル。今スライダーがある点から、残りの点を約40点まで
  // 均等に間引いて辿る。末尾まで来ている(=再生し切った、または手動で末尾へ
  // 動かした)ときは先頭からの再生とみなす。点と点の間はワープさせずフレーム
  // ごとに緯度経度を線形補間して動かす(1点0.25秒。先頭から再生すれば40点で
  // 合計およそ10秒)。実データ点が切り替わるたびに pointIdx を更新し、ステッパ
  // の吹き出し・スライダー位置(下の別effect)はそれに追従する。
  function togglePlay() {
    if (isPlaying) {
      stopPlay();
      return;
    }
    const start = stepIdx >= windowPoints.length - 1 ? 0 : stepIdx;
    const remaining = windowPoints.length - start;
    const seq = samplePlayIndices(remaining, PLAY_STEPS).map((i) => i + start);
    if (seq.length < 2) return;
    setIsPlaying(true);
    playNearestIdxRef.current = seq[0];

    let leg = 0;
    let legStartMs: number | null = null;

    const frame = (now: number) => {
      if (legStartMs === null) legStartMs = now;
      const a = windowPoints[seq[leg]];
      const b = windowPoints[seq[leg + 1]];
      const t = Math.min(1, (now - legStartMs) / PLAY_LEG_MS);
      currentMarkerRef.current?.setPosition({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      });
      playNearestIdxRef.current = t < 0.5 ? seq[leg] : seq[leg + 1];

      if (t >= 1) {
        leg += 1;
        legStartMs = now;
        setPointIdx(seq[leg]);
        if (leg >= seq.length - 1) {
          stopPlay();
          return;
        }
      }
      playAnimRef.current = requestAnimationFrame(frame);
    };
    playAnimRef.current = requestAnimationFrame(frame);
  }

  // 地図は一度だけ生成する(枠切替では作り直さない)。
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !mapRef.current) return;
        const g = (window as unknown as { google: typeof google }).google;
        // 初期表示枠(windowPoints、無ければ全点)があれば、生成時点で先にその
        // 範囲へfitBoundsしておく。あとから effect でフィットし直すと、その一瞬
        // 前まで見えていた適当なcenter/zoomが目に入ってしまうため。
        const initialPoints = windowPoints.length ? windowPoints : points;
        const map = new g.maps.Map(mapRef.current, {
          center: initialPoints.length
            ? { lat: initialPoints[initialPoints.length - 1].lat, lng: initialPoints[initialPoints.length - 1].lng }
            : { lat: 35.681, lng: 139.767 },
          zoom: 15,
          mapTypeControl: true,
          streetViewControl: false,
        });
        if (initialPoints.length) {
          const bounds = new g.maps.LatLngBounds();
          initialPoints.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
          map.fitBounds(bounds);
        }
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
    // 地図生成は一度きり。points/windowPoints は初期枠にのみ使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // 選択中の 1 時間枠の点だけを描画し、その範囲にフィットする。
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

    // 先にカメラを枠の範囲へ合わせる(最大ズーム制限なし)。点を追加してから
    // fitBoundsすると、古いカメラ位置のまま新しい点が一瞬見えたあとにカメラが
    // 動く(プロット→リサイズの順に見える)ため、順序を逆にしている。
    const bounds = new g.maps.LatLngBounds();
    windowPoints.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds);

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

    // 24時間表示は点数が多く(1000点超)、丸マーカーを1点ずつ生成すると描画が
    // 重くなるため間引く。折れ線(runs)は全点のまま描くので軌跡は欠けない。
    // 1時間枠表示は間引かず、全点をタップしてポップアップを見られるようにする。
    const markerStep = fullDay
      ? Math.max(1, Math.ceil(windowPoints.length / MAX_FULLDAY_MARKERS))
      : 1;

    windowPoints.forEach((p, i) => {
      if (markerStep > 1 && i % markerStep !== 0 && i !== windowPoints.length - 1) return;
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
        title: jstTime(p.recordedAt),
      });
      marker.addListener("click", () => {
        if (!info) return;
        info.setContent(popupHtml(p, i, windowPoints.length));
        info.open({ map, anchor: marker });
      });
      plotRef.current.overlays.push(marker);
    });
  }, [mapReady, windowPoints, fullDay]);

  // ステッパの現在点を赤マーカーで強調し、時刻を吹き出しで地図に表示する。
  useEffect(() => {
    if (!mapReady) return;
    const map = mapObjRef.current;
    const g = (window as unknown as { google?: typeof google }).google;
    if (!map || !g) return;

    const isNewWindow = prevWindowRef.current !== windowPoints;
    prevWindowRef.current = windowPoints;

    if (windowPoints.length === 0) {
      currentMarkerRef.current?.setMap(null);
      stepInfoRef.current?.close();
      return;
    }
    const p = windowPoints[stepIdx];
    const pos = { lat: p.lat, lng: p.lng };

    if (!currentMarkerRef.current) {
      currentMarkerRef.current = new g.maps.Marker({
        zIndex: 3000,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: "#dc2626",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
    }
    currentMarkerRef.current.setMap(map);
    currentMarkerRef.current.setPosition(pos);

    if (!stepInfoRef.current) {
      stepInfoRef.current = new g.maps.InfoWindow({ disableAutoPan: true });
    }
    stepInfoRef.current.setContent(
      `<div style="font-size:18px;line-height:1.4">🕐 <b>${jstTime(
        p.recordedAt,
      )}</b><br>${stepIdx + 1} / ${windowPoints.length} 点目</div>`,
    );
    stepInfoRef.current.open({ map, anchor: currentMarkerRef.current });

    // 枠切替は全体フィットに任せる。ステップ移動で現在点が画面外なら寄せる。
    if (!isNewWindow) {
      const b = map.getBounds();
      if (!b || !b.contains(pos)) map.panTo(pos);
    }
  }, [mapReady, windowPoints, stepIdx]);

  // ←/→ キーでのグローバル操作は表示範囲(日付/1時間枠)の前後移動、↑/↓ キーはステッパ
  // (枠内を1点ずつ辿る)の移動。ステッパは詳細パネルの展開有無にかかわらず操作できる。
  // 入力欄などフォーカス中は無視。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isEditableTarget(e.target)) return;

      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && windowPoints.length > 0) {
        e.preventDefault();
        stopPlay();
        if (e.key === "ArrowUp") {
          setPointIdx((i) => Math.max(0, Math.min(i, windowPoints.length - 1) - 1));
        } else {
          setPointIdx((i) => Math.min(windowPoints.length - 1, Math.min(i, windowPoints.length - 1) + 1));
        }
        return;
      }

      if (e.key === "ArrowLeft" && onPrevRange) {
        e.preventDefault();
        onPrevRange();
      } else if (e.key === "ArrowRight" && onNextRange) {
        e.preventDefault();
        onNextRange();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // stopPlay は ref/setState だけを触るので参照が変わっても再登録は不要。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowPoints, onPrevRange, onNextRange]);

  if (error) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  return (
    <div className="flex flex-1 flex-col">
      <div ref={mapRef} className="flex-1" />
      <div className="border-t border-neutral-200 px-4 pb-2 pt-2 dark:border-neutral-800">
        {/* 枠内プロットを1点ずつ辿るステッパ。現在点は地図に赤マーカー+時刻。展開時のみ表示。 */}
        {expanded && windowPoints.length > 0 ? (
          <div className="mb-2 flex items-center gap-2 text-sm">
            <button
              onClick={() => {
                stopPlay();
                setPointIdx((i) => Math.max(0, Math.min(i, windowPoints.length - 1) - 1));
              }}
              className="rounded border border-neutral-300 px-3 py-3 text-lg hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
              disabled={stepIdx <= 0}
              aria-label="前のプロット"
              aria-keyshortcuts="ArrowUp"
            >
              ◀
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, windowPoints.length - 1)}
              value={stepIdx}
              onChange={(e) => {
                stopPlay();
                setPointIdx(Number(e.target.value));
              }}
              className="h-2 flex-1 accent-red-600"
              aria-label="プロットを辿る"
            />
            <button
              onClick={() => {
                stopPlay();
                setPointIdx((i) => Math.min(windowPoints.length - 1, Math.min(i, windowPoints.length - 1) + 1));
              }}
              className="rounded border border-neutral-300 px-3 py-3 text-lg hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
              disabled={stepIdx >= windowPoints.length - 1}
              aria-label="次のプロット"
              aria-keyshortcuts="ArrowDown"
            >
              ▶
            </button>
            {/* 下の日時ナビの「最新」ボタンと右端が揃うよう、行内でいちばん右に置く。
                途中で止めているときだけ「再開」、先頭・末尾(=再生し切った後)は
                「再生」にして、押すと先頭から再生し直す。 */}
            <button
              onClick={togglePlay}
              className="shrink-0 rounded border border-neutral-300 px-3 py-3 text-lg hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
              disabled={!isPlaying && windowPoints.length < 2}
              aria-label={
                isPlaying
                  ? "自動再生を停止"
                  : stepIdx > 0 && stepIdx < windowPoints.length - 1
                    ? "自動再生を再開"
                    : "自動再生を開始"
              }
              aria-pressed={isPlaying}
            >
              {isPlaying ? "停止" : stepIdx > 0 && stepIdx < windowPoints.length - 1 ? "再開" : "再生"}
            </button>
          </div>
        ) : null}

        {/* タップで下の詳細パネルを開閉するハンドル。 */}
        <button
          onClick={() => setExpanded((o) => !o)}
          className="flex w-full flex-col items-center gap-1 py-1"
          aria-expanded={expanded}
          aria-label="詳細の開閉"
        >
          <span className="h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600" />
          <span className="text-xs text-neutral-500 tabular-nums">
            {expanded
              ? "▼ 詳細を閉じる"
              : fullDay
                ? `▲ 24時間 ${windowPoints.length}点 · 除外${meta.excludedTotal}`
                : `▲ この1時間 ${windowPoints.length}点 · 全${points.length}点 · 除外${meta.excludedTotal}`}
          </span>
        </button>

        {expanded ? (
          <div className="mt-2 space-y-3">
            {/* 詳細(日次: 点数・除外内訳・位置不明・日付・device)。 */}
            <div className="space-y-0.5 rounded bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
