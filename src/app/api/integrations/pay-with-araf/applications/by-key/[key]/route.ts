import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/server/db";
import { authenticate, requestCtx } from "@/server/paywitharaf/http";
import { findByIdempotencyKey } from "@/server/paywitharaf/intake";

/** Pay with ARAF asks whether a submission it could not confirm (timeout) already arrived. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const ctx = requestCtx(req);
  const a = await authenticate(req, ctx);
  if ("response" in a) return a.response;
  const ref = await findByIdempotencyKey(db, (await params).key);
  return ref ? NextResponse.json({ araf_reference: ref }) : NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
}
