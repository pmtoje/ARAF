import { NextResponse, type NextRequest } from "next/server";
import { authenticate, requestCtx } from "@/server/paywitharaf/http";
import { IntakeError, receiveReport } from "@/server/paywitharaf/intake";

/** Pay with ARAF reports an execution step (booking, vendor payment, release, delivery) or a customer's reply. */
export async function POST(req: NextRequest) {
  const ctx = requestCtx(req);
  const a = await authenticate(req, ctx);
  if ("response" in a) return a.response;
  try {
    const r = await receiveReport(ctx, a.body);
    return NextResponse.json({ acknowledged: true, event_reference: r.eventReference });
  } catch (e) {
    if (e instanceof IntakeError) return NextResponse.json({ error: e.code }, { status: e.status });
    console.error("[pay-with-araf] report failed", (e as Error).message);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
