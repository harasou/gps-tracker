import { cookies } from "next/headers";
import { setDeviceIdAction } from "./actions";

// トップページ = 端末ID入力ゲート。/map はここで cookie に保存した端末IDの
// 履歴だけを表示する(未指定なら /map からここへリダイレクトされる)。
export default async function Home() {
  const cookieStore = await cookies();
  const deviceId = cookieStore.get("deviceId")?.value ?? "";

  return (
    <main className="mx-auto flex h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-bold">GPS Tracker</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        アプリの「端末ID」欄に表示されている値を入力してください。
      </p>
      <form action={setDeviceIdAction} className="mt-6 flex flex-col gap-3">
        <input
          type="text"
          name="deviceId"
          required
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          defaultValue={deviceId}
          placeholder="android-xxxxxxxx"
          className="rounded border border-neutral-300 px-3 py-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700"
        >
          表示する
        </button>
      </form>
    </main>
  );
}
