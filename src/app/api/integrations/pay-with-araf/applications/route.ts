import { NextResponse, type NextRequest } from "next/server";
import { authenticate, requestCtx } from "@/server/paywitharaf/http";
import { IntakeError, receiveApplication } from "@/server/paywitharaf/intake";

/** Pay with ARAF submits a financing application for credit review. Signed; idempotent on Idempotency-Key. */
export async function POST(req: NextRequest) {
  const ctx = requestCtx(req);
  const a = await authenticate(req, ctx);
  if ("response" in a) return a.response;
  try {
    const r = await receiveApplication(ctx, a.body, req.headers.get("idempotency-key"));
    return NextResponse.json({ araf_reference: r.ref }, { status: r.status });
  } catch (e) {
    if (e instanceof IntakeError) return NextResponse.json({ error: e.code }, { status: e.status });
    console.error("[pay-with-araf] intake failed", (e as Error).message);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
