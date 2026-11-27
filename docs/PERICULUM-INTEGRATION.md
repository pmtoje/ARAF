# Periculum Insights integration — Phase 1 discovery

Status: discovery complete (24 November 2026). Nothing is called live yet; the integration stays OFF in production
until credentials, testing, Information Security / Data Protection approval and the bank's go-ahead are in place.

Source: Periculum Insights API reference (`insights-periculum.readme.io`), every page read in full on 24 Nov 2026.
Only what the reference states is used below; anything it does not state is marked **not documented**.

## 1. What Periculum documents

### Hosts
| Purpose | Documented value |
|---|---|
| Token (OAuth 2.0 client credentials) | `POST https://insightsb2b.auth-periculum.app/realms/prod/protocol/openid-connect/token` |
| API (generic, in the examples) | `https://api.insights-periculum.io` |
| Bank tenancy (supplied by the bank) | `insights-sterlingbankng-api…` — **full host still to be confirmed** (see §5) |
| Sandbox | **not documented** (one example mentions `api.dev.insights-periculum.io`) |

### Authentication
- Form-encoded body: `client_id`, `client_secret`, `grant_type=client_credentials` (credentials from the Insights
  dashboard: Settings → API Settings → API Credentials).
- Response: `access_token`, `expires_in` (86400 s in the example), `token_type: "Bearer"`.
- Calls send `Authorization: Bearer <access_token>`. Expired token → `401`. Periculum recommends refreshing a few
  minutes before expiry.

### Endpoints used by ARAF
| Step | Method and path | Notes |
|---|---|---|
| Submit a PDF statement | `PUT /statements` (multipart) | `file` (required), `password`, `statementType` (`CONSUMER` default, `BUSINESS`, `MOBILE_MONEY`, `MOBILE_MONEY_BUSINESS`), `documentType` (`PDF` default or `SCANNED`). Returns the statement `key` with `processingStatus: UPLOADED`. **This is the billable step.** |
| Status and analytics | `GET /statements/{statementKey}` | Poll every 30–60 s (Periculum's advice) until `processingStatus` is `PROCESSED`. |
| Transactions | `GET /statements/{statementKey}/transactions` | `date`, `amount`, `type` (debit/credit), `description`, `balance`. |
| Attach BVN / NIN | `PATCH /statements/identification` | `statementKey`, `identificationData[{identifierName, value}]`. |
| Link statements (native consolidation) | `PUT /statements/link-multiple-pdfs` (multipart) | `files[]`, `passwords` (comma separated), `statementTypes` (comma separated), `baseStatementKey`, optional `uniqueIdentifier`, `bvn`. |
| Consolidated overview | `GET /statements/consolidatedoverview/{baseStatementKey}` | Totals per bank, salary accounts, loans, self-transfer summary. |
| Periculum affordability | `POST /affordability` | `statementKey`, `dti` (0–1), `loanTenure` (months), optional `averageMonthlyLoanRepaymentAmount`. Decision support only; ARAF's own engine stays authoritative. |
| Analysis report PDF | `/statements/{statementKey}/download?downloadAnalytics=true…` | The reference shows both GET (table) and POST (example). **To be confirmed.** |

### Processing statuses
`UPLOADED`, `PROCESSING`, `PROCESSED`, `FAILED`, `INSUFFIENT BALANCE` (sic), `NO BALANCE`, `NO TRANSACTIONS`,
`NOT ENOUGH TRANSACTIONS`, `ALTERED`.

`ALTERED` is treated as a material exception: the statement may have been tampered with, so it never feeds affordability
and is shown to the analyst.

### Analytics returned per statement (selection)
- **Account:** `bankName`, `accountName`, `accountId`, `accountType`, `accountBalance`, `startDate`, `endDate`,
  `clientFullName`, `confidenceOnParsing`, `pdfCreatedDate`, `pdfModifiedDate`.
- **`cashFlowAnalysis`:**
  - `totalCreditTurnover`, `totalDebitTurnOver`
  - `averageMonthlyCredits` / `averageMonthlyDebits`, `averageMonthlyBalance`
  - `monthlyInflow[]` / `monthlyOutflow[]` (`year`, `month_name`, `amount`)
  - `numberOfTransactingMonths`, `validCredit`
  - `firstDateInStatement` / `lastDateInStatement`, `closingBalance`
- **`incomeAnalysis`:**
  - `isSalaryEarner`, `averagePredictedSalary`, `salaryTransactions[]`
  - `expectedSalaryPaymentDay`, `numberOfSalaryPayments`, `lowestSalary`, `mostRecentSalary`
  - `hasOtherIncome`, `averageOtherIncome`, `otherIncomeTransactions[]`
- **`behavioralAnalysis`:**
  - `totalLoanAmount`, `totalLoanRepaymentAmount`, `averageMonthlyLoanRepaymentAmount`
  - `loanTransactions[]`, `loanRepaymentTransactions[]`
  - `gamblingRate`, `accountSweep`, `percentOfInflowIrregularity`
- **`transactionPatternAnalysis`:**
  - `noOfSelfTransferInflows` / `Outflows`, `selfTransferInflowAmount` / `OutflowAmount`
  - `selfTransferInflowTransactions[]` / `OutflowTransactions[]`
  - `missingTransactions`, `returnCheque`
- **`spendAnalysis`:** `averageMonthlyTotalExpenses`, `averageMonthlyRecurringExpense` and per-category spend.

### Limits, errors, webhooks
- **Limits:** 20 MB per file; 1,000 pages per file; PDF only for this endpoint (scanned PDFs need `documentType=SCANNED`).
- **Errors that matter to ARAF:**
  - password required or incorrect;
  - "Insufficient balance." (the account's credit is exhausted);
  - "A statement with the same name has already been analyzed", so ARAF must send a unique file name per submission.
- **Rate limits and idempotency keys:** not documented. ARAF therefore never blindly re-submits a statement whose
  upload outcome is unknown. It first looks for the earlier submission, and the unique file name makes a duplicate
  submission fail safely instead of being charged twice.
- **Webhooks:**
  - An HTTPS POST, with no authentication, to a URL configured with Periculum. How the URL is registered is not
    documented (dashboard or support).
  - Each body carries `metadata.hmacMessage`, an HMAC-SHA512 of the response object keyed with a 32-character secret.
  - Types: `INSIGHTS`, `AFFORDABILITY`, `CREDITSCORE`.
  - The exact serialisation used for the hash is not specified. ARAF therefore verifies the HMAC, and also re-reads the
    statement with `GET /statements/{key}` before trusting any webhook. Polling remains the fallback.

### Optional: Blacklist Search (added 25 Nov 2026 at the bank's request)
- `POST /statements/blacklistsearch` with `{statementKey, bvn}` returns credit bureau data for that BVN:
  - whether there are facilities, and how many are delinquent, for microfinance, mortgage and credit facilities;
  - the last reported date and report metadata.
- **Off by default** (`PERICULUM_BLACKLIST_ENABLED=false`). It sends the customer's BVN to Periculum, so turning it on
  needs the bank's approval.
- **When it runs:** once per analysis, after at least one statement has been analysed. It searches the applicant's BVN,
  or each director's BVN for a limited company.
- **What is kept:** the full response is stored encrypted. Only non-personal counts are readable; names, date of birth
  and BVN are never shown.
- **No double charges:** a search with an unknown outcome is not repeated.
- **Role:** it supplements the SeedFi credit check and never replaces it or decides anything.
- **Documentation errors:** the example request opens with a stray `{{`, and the response spells
  `mgcreditHasCreditFacilities` both ways. ARAF accepts either spelling.

## 2. Fit with ARAF (what is reused)

| Need | Existing ARAF component |
|---|---|
| Statements stored per application | `documents` (category `BANK_STATEMENT`), encrypted object store, resumable large uploads |
| Seedfi background check | `src/server/credit/seedfi.ts`, unchanged |
| DSR, turnover cap and schedule | `src/server/domain/affordability.ts`: exact BigInt arithmetic, unrounded comparison, rules snapshot. Periculum results feed it; no second engine. |
| 30% DSR | Product configuration (maker-checker, versioned). Salary and income DSR: 30% for Vendor Financing, AltDrive and AltPower. The 10% turnover limits (WakeelBoost, AltDrive business) stay separate turnover rules. Agreed 24 Nov 2026. |
| Credit Analyst decision | `recordFinalAssessment`, the DSR exception process and existing approval actions |
| Async work | `src/server/jobs/worker.ts` loop, outbox, `withTx`, audit, notifications |
| Timeline and audit | `audit_events` (append-only, readable labels) and the case history |

## 3. Consolidation approach

- Periculum's link-multiple-pdfs consolidation reports totals per bank and a self-transfer summary.
- The reference does not say that internal transfers between the customer's accounts are removed from consolidated
  inflows, nor how overlapping periods are handled. ARAF therefore does not rely on it for affordability.
- ARAF consolidates from the per-statement transactions instead:
  - It groups transactions by verified account (bank plus account number).
  - It removes duplicate transactions across overlapping files (same account, date, amount, direction, balance and
    description).
  - It matches debits in one owned account to credits in another owned account (same amount, within a short date
    window) and excludes both as internal transfers. Periculum's own self-transfer flags are used as supporting
    evidence.
  - It keeps every exclusion as evidence.
- The native consolidated overview may be stored for comparison only.

## 4. Billing safeguards

- Uploading a statement never calls Periculum. Only the Credit Analyst's single **Automatic Statement Analysis**
  action does.
- Each file is identified by its SHA-256 hash. If a statement with that hash was already processed, the stored result
  is reused rather than submitted again.
- Viewing a saved report never calls Periculum.

## 5. Outstanding items (vendor and bank)

1. The bank's tenancy API host, in full (the brief gives `insights-sterlingbankng-api…`).
2. Credentials: `client_id` and `client_secret`, from Periculum, for test first.
3. Whether a sandbox or test tenancy exists, and whether statements processed there are charged.
4. The webhook URL registration process and the 32-character secret (optional: polling works without them).
5. Commercial pricing per statement, used for the usage and cost figures. ARAF shows "not configured" until supplied.
6. Data processing agreement, hosting and retention terms, and the Information Security / Data Protection approvals.

---

# Implementation record (Phases 2–7)

## 6. What is built

| Phase | Delivered | Main files |
|---|---|---|
| 2 Backend integration | Secure configuration (server-side only; Super Admin enters credentials, the secret is encrypted and write-only), Periculum adapter, worker processing with bounded concurrency, response validation, encrypted result storage, signed webhook (HMAC-SHA512) with polling fallback, reconciliation of ambiguous submissions, optional Blacklist Search | `src/server/integrations/periculum/*`, `src/server/domain/statement-analysis.ts`, `bureau-check.ts`, `migrations/059–061` |
| 3 Financial intelligence | Per-statement figures, multi-account consolidation, duplicate and overlap removal, transfers between the applicant's own accounts removed, loan proceeds and unverified-account inflows excluded, salary and business intelligence, exceptions with severity | `financial-intelligence.ts` |
| 4 Affordability and recommendation | The existing affordability engine on the verified figures; 30% income DSR (exact, unrounded comparison); declared and detected obligations reconciled (larger used once); maximum eligible amount; eight outcomes; commentary; DSR threshold other than 30% flagged, never overridden | `credit-recommendation.ts` |
| 5 Credit analyst workspace | Financial intelligence tab (before / during / after), one-click Automatic Statement Analysis, retry with reason and passwords, what-if, exceptions, statement and account breakdown, consolidated position, monthly figures and trend chart, role-based view, final assessment pre-filled from the verified figures | `src/app/(app)/requests/[id]/FinancialIntelligence.tsx`, `FiClient.tsx`, `fi-actions.ts` |
| 6 Persistence and workflow | Report saved automatically as a branded PDF document (each regeneration a new version; earlier versions kept; included in the archive pack); analyst confirmation / adjustment history with originals, reason, analyst and time; analysis versioning with "requires refresh" when statements change; facility timeline events; product rule making analysis mandatory, enforced in the workflow engine; Manual Financial Assessment exception through the existing exception process; Unit Head action labelled **Approve for Disbursement**; Financial Intelligence administration (monitoring and usage) | `fi-governance.ts`, `fi-report.ts`, `fi-monitoring.ts`, `migrations/062`, `admin/periculum` |
| 7 Testing and security | See sections 8–10 | `tests/periculum*.test.ts`, `financial-intelligence.test.ts`, `credit-recommendation.test.ts`, `fi-persistence.test.ts` |

### Workflow rules (Phase 6)

- **Mandatory analysis is a product rule** (Product Settings → controls: "Automatic Statement Analysis required before
  credit approval"). It is off for every product until configured and published through the existing Product Settings
  approval. When on, the first credit reviewer's **Approve** is refused by the workflow engine unless there is a
  completed analysis that still matches the application's bank statements, or an approved Manual Financial Assessment
  exception. Hiding a button is never the control.
- **Manual Financial Assessment**: requested by the assigned credit reviewer with a reason and evidence; decided by the
  role configured on the product (blank = not permitted). The final assessment is then labelled *Manual Financial
  Assessment*; the 30% DSR still applies through the same engine.
- **Analyst adjustments**: changing a verified figure (income / inflow or existing obligations) needs a reason of at
  least 10 characters, enforced on the server. The Periculum-derived result on the analysis is never changed; the
  adjusted values, original values, analyst and time are kept in `fi_reviews`, and a new report version is produced.
- **Versioning**: a new analysis supersedes the previous one (kept). The analysis a credit decision relied on is
  marked (`relied_on_at`). An analysis whose statements have changed is shown as *Requires refresh*, is not used to
  pre-fill the assessment and does not satisfy the mandatory-analysis rule.
- **Divisional Head**: reaches the request only after credit review and the Unit Head's approval for disbursement,
  because the stage engine opens that task only after those decisions (unchanged).
- **Who sees what**: credit officers and leads, CX credit reviewer, Unit Head, Divisional Head, Head of Unit,
  disbursement officers and Super Admin see the full report; everyone else allowed on the request (initiator, RM,
  Team Lead) sees the outcome, the amount supported and what may be asked for. All view the same saved version.

## 7. Facility timeline events

Recorded in the existing request history (Activity tab), with actor or *System*, time, outcome and analysis version:
Automatic Statement Analysis started · bank statement processed / could not be processed · statement analysis
completed / partly completed / needs verification / failed · consolidated financial assessment completed · DSR assessed
and recommendation generated · material financial exception identified · Financial Assessment Report saved · credit
analyst confirmed / adjusted the financial assessment · Manual Financial Assessment recorded · existing credit, Unit
Head, Divisional Head and disbursement events.

## 8. Security and customer data protection

| Control | How |
|---|---|
| Credentials | Never in code or the repository; entered by a Super Admin; client secret encrypted (AES-256-GCM field encryption) and never returned to the browser; audit entries name the change, never the value |
| Network | Only `https` hosts under `insights-periculum.io` and `auth-periculum.app` are accepted for the connection |
| Who can run analysis | Only the credit reviewer assigned to the open credit-review task (checked on the server) |
| Who can see detail | Server-side role list (`CREDIT_DETAIL_ROLES`); what-if is refused on the server for other roles |
| Statement data | Vendor responses stored encrypted; PDF passwords encrypted and cleared after submission |
| Account numbers | Stored analysis uses a keyed one-way reference (HMAC) for each account, not the number; screens and the PDF show `••••1234` |
| Webhook | Signature verified (HMAC-SHA512, constant-time compare); invalid signatures audited and ignored; a delivery only brings the next status check forward |
| Billing | SHA-256 de-duplication, reuse of processed statements, one analysis in flight per application, ambiguous submissions reconciled not resent, Blacklist Search with unknown outcome not resent |
| Test data | The simulated service is refused in production and is labelled on every screen, in the report and in the saved assessment note |

## 9. Test coverage

Automated (vitest, real PostgreSQL): sign-in and token reuse; switched-off refusal; upload never calls Periculum;
only the assigned reviewer can start; duplicates; reuse; re-run reason; partial failure and retry; passwords; altered
statements; concurrency; ambiguous submissions (accepted and lost); rate limits; webhook signature and duplicates;
Blacklist Search on/off/unknown/directors; credentials screen rules; consolidation, transfers, ownership, salary and
business intelligence; the brief's 30% DSR example, the exact-30% boundary, missing income, obligation
reconciliation, all outcomes, policy flag; report saved automatically with timeline events; report regeneration
without vendor calls; confirmation and adjustment history; server-side adjustment reason; freshness; mandatory-analysis
gate; Manual Financial Assessment exception; monitoring figures. Browser checks: analyst and initiator views,
before / during / after, what-if, pre-filled assessment, phone width.

## 10. Deployment readiness (do not deploy to production without approval)

1. Run migrations `059`–`062` (Render pre-deploy runs `npm run migrate`).
2. Staging: set `PERICULUM_ENABLED=true` on the staging web project **and** the staging worker; leave
   `PERICULUM_MODE` unset (`live`). Enter the **test** credentials in Administration → Financial Intelligence and run
   **Test sign-in** until it succeeds.
3. Optional: register `<APP_URL>/api/integrations/periculum/webhook` with Periculum and set
   `PERICULUM_WEBHOOK_SECRET` (polling works without it).
4. Run one real test application end to end on staging (statements → analysis → report → confirmation → approvals).
5. For each product that should require analysis, publish the Product Settings change (and the manual-exception
   authority, if the bank permits one) through the normal approval.
6. Production only after: successful staging run, Information Security / Data Protection approval, data processing
   agreement, confirmed pricing (to show charges) and explicit go-live approval. Then repeat steps 2–3 with the live
   credentials.
7. Rollback: set `PERICULUM_ENABLED=false` (analysis stops; saved reports stay viewable; applications on products
   requiring analysis wait for the switch or an approved manual exception).

## 11. Credit Risk Report (bank request, 28 Nov 2026)

Whatever Periculum returns is presented as a **Credit Risk Report**, on screen (Financial intelligence tab) and as the
generated PDF (document type "Credit Risk Report (generated by ARAF)", `src/server/domain/fi-report-pdf.ts`).

- **Risk grade** (Low / Moderate / Elevated / High) from risk indicators in five groups: affordability and debt,
  account conduct, income stability, statement integrity, bureau and background checks (`src/server/domain/fi-risk.ts`).
- **Periculum fields used** (published variable definitions only): `behavioralAnalysis.numberOfBettingTransactions`,
  `gamblingStatus`, `gamblingRate`, `accountSweep`, `percentOfInflowIrregularity`, `loanToInflowRate`;
  `patternAnalysis` / `transactionPatternAnalysis.returnCheque`, `missingTransactions`,
  `percentNumberOfDaysBalanceWasLessThan10ThousandNaira`; `confidenceOnParsing`; `pdfCreatedDate` / `pdfModifiedDate`;
  the ALTERED status. ARAF adds DSR against the 30% limit, lenders being repaid, loan proceeds, volatility, net cash
  flow, salary regularity, coverage, account ownership, SeedFi and Blacklist Search.
- A field Periculum does not return is shown as **not reported**, never as clean.
- **Grade rule**: high = 3 points, watch = 1; High if any statement-integrity, returned-cheque or bureau-delinquency
  signal is high, or 9+ points; Elevated 5–8; Moderate 2–4; Low 0–1.
- **Thresholds are indicative** and kept in one table (`RISK_THRESHOLDS`) for Credit Risk Management to approve or
  change. The grade is decision support; it never approves or declines and does not alter the 30% DSR.
- To confirm with Periculum: whether `gamblingRate` and `loanToInflowRate` are fractions or percentages (ARAF reads
  values of 1 or less as fractions) and the exact key of the pattern block in live responses.
- PDF: charcoal and yellow brand cover; risk grade panel; requested / indicative eligible / recommended / capacity
  tiles; DSR gauge against the 30% limit; recommendation; key risks and mitigants; then every indicator with its
  evidence and source, the monthly inflow/outflow chart and table, accounts, consolidation, affordability, analyst
  review, observations and limitations. Account numbers masked.

## 12. DAO code

The DAO (account officer) code is the first field on the start screen of every retail (Vendor Financing, AltDrive,
AltPower) and WakeelBoost request. A draft cannot be created without it; it stays editable in the draft (Customer
section) and submission is blocked if it is cleared. It appears on the request overview, the Credit Risk Report and
the existing reports/CSV (`daoCode`). Altphones keeps its own separate origination rules.
