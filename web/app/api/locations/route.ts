import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { db, LOCATIONS_COLLECTION } from "@/lib/firebaseAdmin";
import type { LocationInput } from "@/lib/types";

// firebase-admin は Node.js ランタイム必須。Edge では動かない。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 一度の POST で受け付ける最大点数(オフラインバッファのまとめ送り対策)
const MAX_BATCH = 500;

// Bearer トークンを検証する。OK なら null、NG ならエラーレスポンスを返す。
function checkAuth(req: NextRequest): NextResponse | null {
  const expected = process.env.DEVICE_TOKEN;
  if (!expected) {
    // サーバ側の設定漏れ。認証を素通りさせないため 500 で止める。
    return NextResponse.json(
      { error: "server_misconfigured: DEVICE_TOKEN is not set" },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// Firestore に保存する 1 レコード(deviceId/createdAt/_serverTs は POST 側で付与)。
type NormalizedDoc = LocationInput & { hasLocation: boolean };

// 1 レコードを検証・正規化する。座標が取れない「位置不明」レコードも受け付ける。
function normalize(
  raw: unknown,
): { ok: true; value: NormalizedDoc } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "not an object" };
  }
  const r = raw as Record<string, unknown>;

  // recordedAt は ISO8601 想定。無ければ受信時刻で補完する。
  let recordedAt = typeof r.recordedAt === "string" ? r.recordedAt : "";
  if (!recordedAt || Number.isNaN(Date.parse(recordedAt))) {
    recordedAt = new Date().toISOString();
  }

  const lat = Number(r.latitude);
  const lng = Number(r.longitude);
  const hasValidCoords =
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180;

  // 位置不明レコード: クライアントが明示的に locationAvailable=false を送ってきた、
  // または座標が無い場合。座標が付いていないのが正常なので通す。
  if (r.locationAvailable === false || !hasValidCoords) {
    // ただし「座標を送ったつもりが壊れている」データはバグとして弾く。
    if (r.locationAvailable !== false && (r.latitude !== undefined || r.longitude !== undefined)) {
      return { ok: false, reason: "invalid coordinates" };
    }
    return {
      ok: true,
      value: { recordedAt, locationAvailable: false, hasLocation: false },
    };
  }

  const value: NormalizedDoc = {
    latitude: lat,
    longitude: lng,
    recordedAt,
    locationAvailable: true,
    hasLocation: true,
  };

  // 有限値のときだけ代入する(Firestore は undefined を許容しない)。
  const setNum = (key: "accuracy" | "altitude" | "speed" | "bearing", v: unknown) => {
    const n = Number(v);
    if (Number.isFinite(n)) value[key] = n;
  };
  setNum("accuracy", r.accuracy);
  setNum("altitude", r.altitude);
  setNum("speed", r.speed);
  setNum("bearing", r.bearing);

  return { ok: true, value };
}

export async function POST(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;

  // 端末識別子。ヘッダ優先、無ければ body、それも無ければ "unknown"。
  const headerDeviceId = req.headers.get("x-device-id") ?? undefined;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // 単一オブジェクトでも配列でも受け付ける。
  const bodyObj = (body ?? {}) as Record<string, unknown>;
  const rawPoints: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray(bodyObj.points)
      ? (bodyObj.points as unknown[])
      : [body];

  if (rawPoints.length === 0) {
    return NextResponse.json({ error: "no_points" }, { status: 400 });
  }
  if (rawPoints.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `too_many_points (max ${MAX_BATCH})` },
      { status: 413 },
    );
  }

  const deviceId =
    headerDeviceId ||
    (typeof bodyObj.deviceId === "string" ? bodyObj.deviceId : "") ||
    "unknown";

  const createdAt = new Date().toISOString();
  const errors: { index: number; reason: string }[] = [];
  const batch = db.batch();
  const col = db.collection(LOCATIONS_COLLECTION);
  let accepted = 0;

  rawPoints.forEach((raw, index) => {
    const result = normalize(raw);
    if (!result.ok) {
      errors.push({ index, reason: result.reason });
      return;
    }
    batch.set(col.doc(), {
      ...result.value,
      deviceId,
      createdAt,
      // 時刻順クエリを安定させるためのサーバ側タイムスタンプ
      _serverTs: FieldValue.serverTimestamp(),
    });
    accepted += 1;
  });

  if (accepted === 0) {
    return NextResponse.json(
      { error: "all_points_invalid", details: errors },
      { status: 400 },
    );
  }

  await batch.commit();

  return NextResponse.json(
    { accepted, rejected: errors.length, errors: errors.length ? errors : undefined },
    { status: 201 },
  );
}
