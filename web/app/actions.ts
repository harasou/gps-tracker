"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEVICE_ID_COOKIE, DEVICE_ID_COOKIE_MAX_AGE_SEC } from "@/lib/deviceIdCookie";

// 入力された端末IDを cookie に保存する。以降 /map は cookie の値で絞り込む。
export async function setDeviceIdAction(formData: FormData) {
  const value = String(formData.get("deviceId") ?? "").trim();
  if (!value) return;

  const cookieStore = await cookies();
  cookieStore.set(DEVICE_ID_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_ID_COOKIE_MAX_AGE_SEC,
  });
  redirect("/map");
}
