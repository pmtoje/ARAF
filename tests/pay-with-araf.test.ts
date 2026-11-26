import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, withTx } from "@/server/db";
import { resetDb, staffId } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { createSession } from "@/server/auth/session";
import { signPwa } from "@/server/paywitharaf/signing";
import { actOnCase, availableActions, type PwaCase } from "@/server/paywitharaf/cases";
import { processPwaCallbacks } from "@/server/paywitharaf/callbacks";
import { exchangeSsoCode, issueSsoCode } from "@/server/paywitharaf/sso";
import { POST as submitRoute } from "@/app/api/integrations/pay-with-araf/applications/route";
import { GET as byKeyRoute } from "@/app/api/integrations/pay-with-araf/applications/by-key/[key]/route";
import { POST as reportRoute } from "@/app/api/integrations/pay-with-araf/reports/route";
import { POST as tokenRoute } from "@/app/api/sso/pay-with-araf/token/route";

const SECRET = "pwa-test-secret-0123456789abcdef0123456789";
const REDIRECT = "https://admin.araf.test/api/auth/admin/sso/callback";
const ENV: Record<string, string> = {
  PAY_WITH_ARAF_ENABLED: "true",
  PAY_WITH_ARAF_SECRET: SECRET,
  PAY_WITH_ARAF_CALLBACK_URL: "https://api.araf.test/api/callbacks/araf",
  PAY_WITH_ARAF_SSO_REDIRECT_URIS: REDIRECT,
};
const saved: Record<string, string | undefined> = {};
const BVN = "22212345678";

function signed(method: "GET" | "POST", path: string, body = "", headers: Record<string, string> = {}, t = Math.floor(Date.now() / 1000)) {
  return new NextRequest(`https://araf.test${path}`, {
    method,
    body: method === "POST" ? body : undefined,
    headers: { "content-type": "application/json", "x-pwa-timestamp": String(t), "x-pwa-signature": signPwa(SECRET, t, method, path, body), ...headers },
  });
}

function submission(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    application_reference: "PWA-APP-0001",
    partner_id: "ALTMALL",
    merchant_order_reference: "AM-1001",
    customer: { first_name: "Ada", last_name: "Obi", verified_bvn: BVN, income_profile: "SALARY_EARNER" },
    seedfi_assessment: { reference: "SF-1", band: "B", bureau_monthly_obligations_kobo: "5000000" },
    periculum_analysis: { reference: "PC-1", average_inflow_kobo: "60000000", statement_quality: "GOOD" },
    affordability: { repayment_ceiling: "TOTAL_OBLIGATIONS_MAX_33_3PCT_OF_MONTHLY_SALARY", capacity_kobo: "14980000" },
    financing: {
      purchase_amount_kobo: "500000000",
      customer_equity_kobo: "200000000",
      requested_amount_kobo: "300000000",
      deferred_sale_price_kobo: "375000000",
      tenor_months: 12,
      annual_profit_rate_bps: 2500,
      schedule: [{ n: 1, amount_kobo: "31250000" }],
    },
    ...over,
  });
}

const PATH = "/api/integrations/pay-with-araf/applications";

async function submit(key = "araf-submit-app-0001") {
  const res = await submitRoute(signed("POST", PATH, submission(), { "idempotency-key": key }));
  return { status: res.status, json: (await res.json()) as { araf_reference?: string; error?: string } };
}

async function caseByRef(ref: string) {
  return (await db.query<PwaCase>("SELECT * FROM pwa_cases WHERE ref = $1", [ref])).rows[0];
}

async function act(email: string, ref: string, action: Parameters<typeof actOnCase>[1]["action"], note = "Checked and recorded.") {
  const c = await caseByRef(ref);
  return actOnCase(await ctxFor(email), { caseId: c.id, action, note, lockVersion: c.lock_version });
}

async function callbacks(ref: string) {
  return (
    await db.query(
      "SELECT o.sequence, o.status, o.body::jsonb AS body FROM pwa_callback_outbox o JOIN pwa_cases c ON c.id = o.case_id WHERE c.ref = $1 ORDER BY o.sequence",
      [ref],
    )
  ).rows as { sequence: number; status: string; body: Record<string, unknown> }[];
}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  await resetDb();
});

describe("Pay with ARAF intake (signed integration API)", () => {
  it("creates one case per idempotency key and answers lookups by key", async () => {
    const first = await submit();
    expect(first.status).toBe(201);
    expect(first.json.araf_reference).toMatch(/^PWA-\d{4}-\d{6}$/);
    const again = await submit();
    expect(again.status).toBe(200);
    expect(again.json.araf_reference).toBe(first.json.araf_reference);
    expect(Number((await db.query("SELECT count(*) AS n FROM pwa_cases")).rows[0].n)).toBe(1);

    const found = await byKeyRoute(signed("GET", `${PATH}/by-key/araf-submit-app-0001`), { params: Promise.resolve({ key: "araf-submit-app-0001" }) });
    expect(found.status).toBe(200);
    expect(((await found.json()) as { araf_reference: string }).araf_reference).toBe(first.json.araf_reference);
    const missing = await byKeyRoute(signed("GET", `${PATH}/by-key/araf-submit-other`), { params: Promise.resolve({ key: "araf-submit-other" }) });
    expect(missing.status).toBe(404);
  });

  it("stores the BVN only encrypted and the last four digits; audits never contain it", async () => {
    const { json } = await submit();
    const c = await caseByRef(json.araf_reference!);
    expect(c.bvn_last4).toBe("5678");
    expect(c.payload_enc).not.toContain(BVN);
    const audit = JSON.stringify((await db.query("SELECT details FROM audit_events WHERE action LIKE 'PWA_%'")).rows);
    expect(audit).not.toContain(BVN);
    // Credit staff are told a case is waiting.
    const n = await db.query("SELECT count(*) AS n FROM notifications WHERE kind = 'PWA_RECEIVED' AND recipient_id = $1", [await staffId("co1@altbank.ng")]);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("refuses unsigned, tampered and stale requests; a repeated request is answered idempotently; invisible when off", async () => {
    const body = submission();
    const t = Math.floor(Date.now() / 1000);
    const tampered = new NextRequest(`https://araf.test${PATH}`, { method: "POST", body: body.replace("Ada", "Eve"), headers: { "x-pwa-timestamp": String(t), "x-pwa-signature": signPwa(SECRET, t, "POST", PATH, body), "idempotency-key": "k-tampered-01" } });
    expect((await submitRoute(tampered)).status).toBe(401);
    expect((await submitRoute(new NextRequest(`https://araf.test${PATH}`, { method: "POST", body, headers: { "idempotency-key": "k-unsigned-01" } }))).status).toBe(401);
    expect((await submitRoute(signed("POST", PATH, body, { "idempotency-key": "k-stale-0001" }, t - 600))).status).toBe(401);
    const once = signed("POST", PATH, body, { "idempotency-key": "k-replay-001" }, t);
    const twice = signed("POST", PATH, body, { "idempotency-key": "k-replay-001" }, t);
    const a = await submitRoute(once);
    const b = await submitRoute(twice);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(((await b.json()) as { araf_reference: string }).araf_reference).toBe(((await a.json()) as { araf_reference: string }).araf_reference);
    process.env.PAY_WITH_ARAF_ENABLED = "false";
    try {
      expect((await submitRoute(signed("POST", PATH, body, { "idempotency-key": "k-disabled-1" }))).status).toBe(404);
    } finally {
      process.env.PAY_WITH_ARAF_ENABLED = "true";
    }
  });

  it("rejects submissions whose amounts do not add up (equity + financed = price)", async () => {
    const bad = submission({ financing: { purchase_amount_kobo: "500000000", customer_equity_kobo: "200000000", requested_amount_kobo: "500000000", tenor_months: 12 } });
    const res = await submitRoute(signed("POST", PATH, bad, { "idempotency-key": "k-bad-amounts" }));
    expect(res.status).toBe(422);
    const long = submission({ financing: { purchase_amount_kobo: "300000000", requested_amount_kobo: "300000000", tenor_months: 36 } });
    expect((await submitRoute(signed("POST", PATH, long, { "idempotency-key": "k-too-long-1" }))).status).toBe(422);
  });
});

describe("Pay with ARAF review workflow", () => {
  it("runs evaluation → information request → customer reply → recommendation → approval, sending each decision back", async () => {
    const ref = (await submit()).json.araf_reference!;
    await act("co1@altbank.ng", ref, "START_EVALUATION");
    await act("co1@altbank.ng", ref, "COMPLETE_EVALUATION");
    await act("co1@altbank.ng", ref, "REQUEST_INFO", "Upload your latest payslip.");
    expect((await caseByRef(ref)).stage).toBe("INFO_REQUESTED");

    const report = JSON.stringify({ eventId: "pwa-evt-000001", arafReference: ref, applicationReference: "PWA-APP-0001", type: "CUSTOMER_INFORMATION_PROVIDED", sequence: 1, occurredAt: new Date().toISOString(), data: { note: "Payslip uploaded", bvn: BVN } });
    const r1 = await reportRoute(signed("POST", "/api/integrations/pay-with-araf/reports", report));
    expect(r1.status).toBe(200);
    const ack = (await r1.json()) as { acknowledged: boolean; event_reference: string };
    expect(ack.acknowledged).toBe(true);
    expect((await caseByRef(ref)).stage).toBe("CREDIT_REVIEW");
    // The same event again is acknowledged with the same reference and changes nothing.
    const r2 = await reportRoute(signed("POST", "/api/integrations/pay-with-araf/reports", report));
    expect(((await r2.json()) as { event_reference: string }).event_reference).toBe(ack.event_reference);
    const stored = (await db.query("SELECT data FROM pwa_execution_reports")).rows;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(BVN);

    await act("lead1@altbank.ng", ref, "RECOMMEND_APPROVAL");
    // Maker-checker: the recommender cannot approve.
    await expect(act("lead1@altbank.ng", ref, "APPROVE")).rejects.toThrow(/another approver/);
    // A credit officer is not an approver.
    await expect(act("co1@altbank.ng", ref, "APPROVE")).rejects.toThrow();
    await act("unit.head@altbank.ng", ref, "APPROVE", "Within policy.");
    const c = await caseByRef(ref);
    expect(c.stage).toBe("APPROVED");
    expect(c.decided_by).toBe(await staffId("unit.head@altbank.ng"));

    const sent = await callbacks(ref);
    expect(sent.map((x) => x.body.stage)).toEqual(["UNDER_REVIEW", "INFO_REQUESTED", "INFO_PROVIDED", "APPROVED"]);
    expect(sent.map((x) => x.sequence)).toEqual([1, 2, 3, 4]);
    expect(sent[1].body.note).toBe("Upload your latest payslip.");
    expect(sent[3].body.decision).toBe("APPROVED");
    // Internal notes (e.g. the approval note) are not sent to Pay with ARAF.
    expect(sent[3].body.note).toBeUndefined();
  });

  it("refuses an action on a stale view and offers only the actions a person may take", async () => {
    const ref = (await submit()).json.araf_reference!;
    const c = await caseByRef(ref);
    await act("co1@altbank.ng", ref, "START_EVALUATION");
    await expect(actOnCase(await ctxFor("co1@altbank.ng"), { caseId: c.id, action: "REJECT", note: "Stale screen", lockVersion: c.lock_version })).rejects.toThrow(/changed/);
    const now = await caseByRef(ref);
    expect(availableActions(now, await staffId("co1@altbank.ng"), ["CREDIT_OFFICER_1"])).toEqual(["COMPLETE_EVALUATION", "REQUEST_INFO", "REJECT"]);
    expect(availableActions(now, await staffId("tomiwa.adebanjo@altbank.ng"), ["SUPER_ADMIN"])).toEqual([]);
  });

  it("delivers callbacks signed and in order, retrying after a failure", async () => {
    const ref = (await submit()).json.araf_reference!;
    await act("co1@altbank.ng", ref, "START_EVALUATION");
    await act("co1@altbank.ng", ref, "REJECT", "Outside policy.");
    const seen: { stage: string; ok: boolean }[] = [];
    let fail = true;
    const fake = (async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      const h = new Headers(init?.headers);
      const t = Number(h.get("x-araf-timestamp"));
      expect(h.get("x-araf-signature")).toBe(signPwa(SECRET, t, "POST", u.pathname, String(init?.body)));
      const stage = JSON.parse(String(init?.body)).stage as string;
      seen.push({ stage, ok: !fail });
      if (fail) {
        fail = false;
        return new Response("", { status: 503 });
      }
      return new Response(JSON.stringify({ outcome: "APPLIED" }), { status: 200 });
    }) as typeof fetch;

    const first = await processPwaCallbacks(new Date(), 20, fake);
    // The first callback failed, so the second waited behind it.
    expect(first).toEqual({ sent: 0, failed: 1 });
    expect(seen.map((s) => s.stage)).toEqual(["UNDER_REVIEW"]);
    const later = new Date(Date.now() + 5 * 60_000);
    await processPwaCallbacks(later, 20, fake);
    await processPwaCallbacks(later, 20, fake);
    expect(seen.map((s) => s.stage)).toEqual(["UNDER_REVIEW", "UNDER_REVIEW", "REJECTED"]);
    expect((await callbacks(ref)).map((x) => x.status)).toEqual(["SENT", "SENT"]);
  });
});

describe("Staff sign-in to Pay with ARAF with an ARAF account", () => {
  async function signedInCtx(email: string) {
    const ctx = await ctxFor(email);
    const s = await withTx((tx) => createSession(tx, ctx, ctx.actor!.staffId, null));
    ctx.actor!.sessionId = s.sessionId;
    return ctx;
  }

  it("issues a single-use code that Pay with ARAF exchanges once for the person's identity", async () => {
    const ctx = await signedInCtx("lead1@altbank.ng");
    const code = await issueSsoCode(ctx, REDIRECT);
    const tokenPath = "/api/sso/pay-with-araf/token";
    const res = await tokenRoute(signed("POST", tokenPath, JSON.stringify({ code, redirect_uri: REDIRECT })));
    expect(res.status).toBe(200);
    const id = (await res.json()) as { email: string; name: string; auth_time: number; amr: string[] };
    expect(id.email).toBe("lead1@altbank.ng");
    expect(id.amr).toEqual(["otp"]);
    expect(Math.abs(id.auth_time - Math.floor(ctx.now.getTime() / 1000))).toBeLessThanOrEqual(1);
    // Single use.
    expect((await tokenRoute(signed("POST", tokenPath, JSON.stringify({ code, redirect_uri: REDIRECT })))).status).toBe(400);
  });

  it("refuses unknown redirects, the wrong redirect, expired codes and revoked sessions", async () => {
    const ctx = await signedInCtx("co1@altbank.ng");
    await expect(issueSsoCode(ctx, "https://evil.example/callback")).rejects.toThrow(/not allowed/);
    const code = await issueSsoCode(ctx, REDIRECT);
    expect(await exchangeSsoCode(db, ctx, code, "https://admin.araf.test/other")).toBeNull();
    const late = { ...ctx, now: new Date(ctx.now.getTime() + 61_000) };
    expect(await exchangeSsoCode(db, late, code, REDIRECT)).toBeNull();

    const code2 = await issueSsoCode(ctx, REDIRECT);
    await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [ctx.actor!.sessionId]);
    expect(await exchangeSsoCode(db, ctx, code2, REDIRECT)).toBeNull();
  });
});
