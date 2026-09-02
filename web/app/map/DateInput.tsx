"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";

// 日付をボタン風に表示し、タップでネイティブカレンダーを開く。
// 選んだ瞬間に /map?date=... へ遷移する(「表示」ボタン不要)。
export default function DateInput({
  current,
  deviceId,
}: {
  current: string;
  deviceId?: string;
}) {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [, m, d] = current.split("-");
  const label = `${Number(m)}/${Number(d)}`;

  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center rounded border border-neutral-300 px-3 py-3 text-base tabular-nums hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
      📅 {label}
      <input
        ref={ref}
        type="date"
        defaultValue={current}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker();
          } catch {
            // showPicker 非対応ブラウザ: フォーカス時のネイティブ挙動に任せる。
          }
        }}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const p = new URLSearchParams();
          p.set("date", v);
          if (deviceId) p.set("deviceId", deviceId);
          router.push(`/map?${p.toString()}`);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="日付を選択"
      />
    </label>
  );
}
