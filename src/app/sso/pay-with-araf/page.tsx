import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { auditOutsideTx } from "@/server/audit";
import { isAllowedRedirect, issueSsoCode } from "@/server/paywitharaf/sso";

export const dynamic = "force-dynamic";
export const metadata = { title: "Signing in to Pay with ARAF" };

/**
 * Staff sign-in for Pay with ARAF's admin portal. The person signs in to ARAF as usual (@altbank.ng email OTP);
 * ARAF then sends a single-use, 60-second code to the allow-listed Pay with ARAF redirect. Pay with ARAF decides
 * what the person may do there.
 */
export default async function PayWithArafSso({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const redirectUri = sp.redirect_uri ?? "";
  const state = sp.state ?? "";
  const valid = isAllowedRedirect(redirectUri) && /^[A-Za-z0-9_-]{16,128}$/.test(state);
  const next = `/sso/pay-with-araf?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  const { ctx } = await requireUser({ next });
  if (!valid) {
    await auditOutsideTx(ctx, { action: "PWA_SSO_REFUSED", outcome: "DENIED", reason: "REDIRECT_OR_STATE" });
    return (
      <main className="auth-shell">
        <div className="card">
          <h1>Sign-in link not recognised</h1>
          <p>Go back to Pay with ARAF and choose “Sign in with ARAF” again.</p>
        </div>
      </main>
    );
  }
  const code = await issueSsoCode(ctx, redirectUri);
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  redirect(target.toString());
}
