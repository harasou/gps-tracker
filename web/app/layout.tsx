import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPS Tracker",
  description: "端末の位置情報を記録して地図上で確認する",
  // 検索エンジンにインデックスさせない(位置情報を扱うため)。
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
