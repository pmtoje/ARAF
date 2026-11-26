import { NextResponse, type NextRequest } from "next/server";
import { db } from "../db";
import type { Ctx } from "../context";
import { clientIpFromHeaders } from "../context";
import { auditOutsideTx } from "../audit";
import { verifyPwaRequest } from "./signing";

export const MAX_BODY_BYTES = 1024 * 1024;

export function requestCtx(req: NextRequest): Ctx {
  return {
    actor: null,
    now: new Date(),
    correlationId: req.headers.get("x-correlation-id") ?? crypto.randomUUID(),
    ip: clientIpFromHeaders((n) => req.headers.get(n)),
    userAgent: "pay-with-araf",
  };
}

/** Read and verify a signed request from Pay with ARAF. Returns the raw body, or an error response. */
export async function authenticate(req: NextRequest, ctx: Ctx): Promise<{ body: string } | { response: NextResponse }> {
  const body = req.method === "GET" ? "" : await req.text();
  if (body.length > MAX_BODY_BYTES) return { response: NextResponse.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 }) };
  // Sign the raw (still percent-encoded) path, as Pay with ARAF does.
  const path = new URL(req.url).pathname;
  const v = await verifyPwaRequest(db, { method: req.method, path, body, timestamp: req.headers.get("x-pwa-timestamp"), signature: req.headers.get("x-pwa-signature") }, ctx.now);
  if (!v.ok) {
    await auditOutsideTx(ctx, { action: "PWA_REQUEST_REFUSED", outcome: "DENIED", reason: v.reason, details: { path } });
    return { response: NextResponse.json({ error: v.reason === "DISABLED" ? "NOT_FOUND" : "UNAUTHENTICATED" }, { status: v.reason === "DISABLED" ? 404 : 401 }) };
  }
  return { body };
}
