# Pay with ARAF connection

Pay with ARAF is the embedded-checkout financing gateway (non-interest, Murabaha). It is a **separate
application** with its own repository and database. ARAF connects to it in two ways:

1. **Credit review.** Pay with ARAF submits each application to ARAF after running its checks (SeedFi,
   Periculum, affordability: 33.3% of salary or 10% of turnover; tenor up to 24 months). ARAF credit staff
   review and decide it under **Pay with ARAF → Checkout applications**. Each decision goes back to Pay with
   ARAF as a signed callback. Pay with ARAF then reports the execution steps (booking, vendor payment,
   release, delivery) to ARAF for the record.
2. **Staff sign-in.** Bank staff sign in to Pay with ARAF's admin portal with their ARAF account (the
   @altbank.ng email OTP). ARAF only confirms who the person is. Pay with ARAF decides what they may do.

Both are off until `PAY_WITH_ARAF_ENABLED=true` and the shared secret is set.

## Configuration

| Variable | Purpose |
|---|---|
| `PAY_WITH_ARAF_ENABLED` | `true` turns on the endpoints, the menu and the callback job. |
| `PAY_WITH_ARAF_SECRET` | HMAC secret shared with Pay with ARAF (its `ARAF_INTEGRATION_SECRET`). At least 32 characters, from the secrets manager. |
| `PAY_WITH_ARAF_CALLBACK_URL` | Pay with ARAF's callback endpoint, e.g. `https://api.araf.ng/api/callbacks/araf`. Must be https in production. |
| `PAY_WITH_ARAF_SSO_REDIRECT_URIS` | Exact redirect URIs allowed for sign-in, comma-separated, e.g. `https://admin.araf.ng/api/auth/admin/sso/callback`. |
| `PAY_WITH_ARAF_TIMEOUT_MS` | Timeout for each callback (default 12000). |

On the Pay with ARAF side, set `ARAF_MODE=connected`, `ARAF_BASE_URL` (this app's URL),
`ARAF_INTEGRATION_SECRET` (the same secret) and `ARAF_SSO_ENABLED=true`.

## Signing (contract v1, both directions)

```
signature = "v1=" + hex(HMAC-SHA256(secret, `${unix_seconds}.${METHOD}.${path}.${raw_body}`))
```

* Pay with ARAF → ARAF: `X-PWA-Timestamp`, `X-PWA-Signature`.
* ARAF → Pay with ARAF: `X-ARAF-Timestamp`, `X-ARAF-Signature`. The path is the callback URL's path.
* A timestamp more than 300 seconds from ARAF's clock is refused.
* A repeated request inside that window is answered idempotently rather than refused. The same
  `Idempotency-Key` returns the same case, reports are de-duplicated by event id, and sign-in codes are
  single-use.

## Endpoints in ARAF (called by Pay with ARAF)

| Method and path | Result |
|---|---|
| `POST /api/integrations/pay-with-araf/applications` (header `Idempotency-Key`) | `201 {araf_reference}` new, `200` repeat. `422` if the amounts do not add up (equity + financed ≠ price) or the tenor exceeds 24 months. |
| `GET /api/integrations/pay-with-araf/applications/by-key/{key}` | `200 {araf_reference}` or `404`. Pay with ARAF asks this after a timeout, before any retry. |
| `POST /api/integrations/pay-with-araf/reports` | `200 {acknowledged: true, event_reference}`. A `CUSTOMER_INFORMATION_PROVIDED` report returns a case waiting on the customer to review. |
| `POST /api/sso/pay-with-araf/token` `{code, redirect_uri}` | `200 {email, name, auth_time, amr}` once per code, `400` otherwise. |

Unsigned or badly signed requests get `401`. When the integration is off, every endpoint answers `404`.

## Review workflow

`RECEIVED → BUSINESS_EVALUATION → CREDIT_REVIEW → APPROVAL → APPROVED`. From evaluation or credit review a
case can go to `INFO_REQUESTED` (waiting on the customer). From evaluation, credit review or approval it can
go to `REJECTED`.

* **Credit officers, Credit Leads and the Unit Head** evaluate, ask the customer for information, recommend
  and reject.
* **Credit Leads and the Unit Head** approve, return a case to credit review, or reject at approval.
* The person who recommended approval **cannot** approve the same case.
* Every action needs a note and is checked against the version the person was looking at.
* Every action is recorded in the case history (append-only) and the audit trail.

Callbacks sent to Pay with ARAF:

| Action in ARAF | Callback stage |
|---|---|
| Start business evaluation | `UNDER_REVIEW` |
| Ask the customer for information | `INFO_REQUESTED`, with the note. The customer sees the note in the checkout. |
| Customer's reply arrives | `INFO_PROVIDED` |
| Approve | `APPROVED` (decision `APPROVED`) |
| Reject | `REJECTED` (decision `REJECTED`). The internal reason is not sent. |

The worker delivers callbacks from `pwa_callback_outbox`:

* Each case's callbacks go out in sequence order; a later one waits until the earlier ones are delivered.
* Failures retry with backoff. After 10 attempts a callback is `DEAD` and Super Admins are notified.
* A Super Admin can send undelivered updates again from the case page.

## Data handling

* The full submission is stored encrypted (`payload_enc`). Columns hold the summary and the BVN's last four
  digits only. Reviewers see the BVN masked.
* Audit events and execution reports never contain the BVN.
* Report fields named like BVN, NIN, OTP, PIN, password or account number are dropped.

## Sign-in flow

1. On Pay with ARAF's admin sign-in page, the person chooses **Sign in with ARAF (@altbank.ng)**.
2. Pay with ARAF sends them to `/sso/pay-with-araf?redirect_uri=…&state=…` here. ARAF signs them in as usual
   if needed.
3. The `redirect_uri` must be on the allowlist. ARAF issues a single-use 60-second code, stored as an HMAC,
   and redirects back with `code` and `state`.
4. Pay with ARAF checks `state`, then exchanges the code server-to-server (signed). It admits the person only
   if they hold an active Bank staff account on Pay with ARAF.

The exchange is refused if the code has expired or was already used, if the redirect differs, if the person
is no longer active, or if their ARAF session was revoked.

## Data model (migration 062)

* `pwa_cases`
* `pwa_case_events` (append-only)
* `pwa_execution_reports` (append-only, unique event id)
* `pwa_callback_outbox`
* `pwa_sso_codes`
