import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { DEVICE_ID_COOKIE, DEVICE_ID_COOKIE_MAX_AGE_SEC } from "@/lib/deviceIdCookie";

// /map に URL パラメータで deviceId が渡された場合、cookie にも保存する。
// (Server Component の描画中は cookie を書けないため middleware で行う)
export function proxy(req: NextRequest) {
  const deviceId = req.nextUrl.searchParams.get("deviceId");
  if (!deviceId || req.cookies.get(DEVICE_ID_COOKIE)?.value === deviceId) {
    return NextResponse.next();
  }

  const res = NextResponse.next();
  res.cookies.set(DEVICE_ID_COOKIE, deviceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_ID_COOKIE_MAX_AGE_SEC,
  });
  return res;
}

export const config = {
  matcher: "/map",
};
