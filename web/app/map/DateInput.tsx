"use client";

import { useRef } from "react";

// 日付をボタン風に表示し、タップでネイティブカレンダーを開く。
// 選んだ瞬間に onSelect(遷移は呼び出し側が担当。ローディング状態をまとめて管理するため)。
export default function DateInput({
  current,
  disabled,
  onSelect,
}: {
  current: string;
  disabled?: boolean;
  onSelect: (date: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [, m, d] = current.split("-");
  const label = `${Number(m)}/${Number(d)}`;

  return (
    <label
      className={`relative inline-flex shrink-0 cursor-pointer items-center overflow-hidden rounded border border-neutral-300 px-3 py-3 text-lg tabular-nums hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 ${
        disabled ? "pointer-events-none opacity-40" : ""
      }`}
    >
      📅 {label}
      <input
        ref={ref}
        type="date"
        defaultValue={current}
        disabled={disabled}
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
          onSelect(v);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="日付を選択"
      />
    </label>
  );
}
