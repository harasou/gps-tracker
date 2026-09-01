import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold">GPS Tracker</h1>
      <p className="mt-4 text-neutral-600 dark:text-neutral-400">
        Android アプリが一定間隔で送信した位置情報を記録し、地図上で軌跡を確認できます。
      </p>

      <div className="mt-8">
        <Link
          href="/map"
          className="inline-block rounded-lg bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700"
        >
          地図で軌跡を見る →
        </Link>
      </div>

      <section className="mt-12 text-sm text-neutral-500 dark:text-neutral-400">
        <h2 className="font-semibold text-neutral-700 dark:text-neutral-300">
          API エンドポイント
        </h2>
        <p className="mt-2">
          Android アプリはこの URL に位置情報を POST します:
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-100 p-3 dark:bg-neutral-900">
          POST /api/locations
        </pre>
      </section>
    </main>
  );
}
