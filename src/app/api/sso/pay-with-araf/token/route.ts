import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { authenticate, requestCtx } from "@/server/paywitharaf/http";
import { exchangeSsoCode } from "@/server/paywitharaf/sso";

const bodySchema = z.object({ code: z.string().max(200), redirect_uri: z.string().url().max(500) }).strict();

/** Pay with ARAF exchanges a single-use sign-in code for the staff member's identity (server-to-server, signed). */
export async function POST(req: NextRequest) {
  const ctx = requestCtx(req);
  const a = await authenticate(req, ctx);
  if ("response" in a) return a.response;
  let parsed;
  try {
    parsed = bodySchema.safeParse(JSON.parse(a.body));
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const id = await exchangeSsoCode(db, ctx, parsed.data.code, parsed.data.redirect_uri);
  if (!id) return NextResponse.json({ error: "INVALID_GRANT" }, { status: 400 });
  return NextResponse.json(id, { headers: { "Cache-Control": "no-store" } });
}
