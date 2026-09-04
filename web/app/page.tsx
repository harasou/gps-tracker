import { redirect } from "next/navigation";

// トップページはそのまま /map へ。deviceId 入力欄などは表示しない
// (deviceId は URL パラメータ経由で受け取る想定 — proxy.ts が cookie に保存する)。
export default function Home() {
  redirect("/map");
}
