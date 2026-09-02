"use client";

import { useRouter } from "next/navigation";

// 日付を選んだ瞬間に /map?date=... へ遷移する(「表示」ボタン不要)。
export default function DateInput({
  current,
  deviceId,
}: {
  current: string;
  deviceId?: string;
}) {
  const router = useRouter();
  return (
    <input
      type="date"
      defaultValue={current}
      onChange={(e) => {
        const d = e.target.value;
        if (!d) return;
        const p = new URLSearchParams();
        p.set("date", d);
        if (deviceId) p.set("deviceId", deviceId);
        router.push(`/map?${p.toString()}`);
      }}
      className="rounded border border-neutral-300 px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
    />
  );
}
