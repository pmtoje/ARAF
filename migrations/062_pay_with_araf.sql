-- Pay with ARAF (embedded-checkout Murabaha financing) connected to ARAF.
-- Pay with ARAF is a separate application. It submits applications here over a signed integration API;
-- ARAF staff review and decide them; ARAF sends signed status callbacks back; Pay with ARAF reports
-- execution steps (booking, vendor payment, release, delivery) for the record. ARAF also acts as the
-- sign-in provider for Pay with ARAF's Bank staff (single-use codes, see pwa_sso_codes).

CREATE TABLE pwa_cases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                 text NOT NULL UNIQUE,              -- ARAF reference returned to Pay with ARAF (PWA-YYYY-NNNNNN)
  idempotency_key     text NOT NULL UNIQUE,
  pwa_reference       text NOT NULL,                     -- Pay with ARAF application reference
  partner_code        text NOT NULL,
  partner_name        text,
  merchant_order_ref  text NOT NULL,
  customer_name       text NOT NULL,
  bvn_last4           text,
  income_profile      text,
  purchase_kobo       bigint NOT NULL CHECK (purchase_kobo >= 0),
  equity_kobo         bigint NOT NULL DEFAULT 0 CHECK (equity_kobo >= 0),
  financing_kobo      bigint NOT NULL CHECK (financing_kobo >= 0),
  deferred_sale_kobo  bigint,
  monthly_kobo        bigint,
  tenor_months        int,
  annual_rate_bps     int,
  payload_enc         text NOT NULL,                     -- full submission, encrypted (contains BVN and account numbers)
  stage               text NOT NULL CHECK (stage IN ('RECEIVED','BUSINESS_EVALUATION','CREDIT_REVIEW','APPROVAL','INFO_REQUESTED','APPROVED','REJECTED')),
  stage_before_info   text,
  sequence            int NOT NULL DEFAULT 0,            -- last callback sequence sent to Pay with ARAF
  recommended_by      uuid REFERENCES staff(id),
  decided_by          uuid REFERENCES staff(id),
  execution_status    text,                              -- latest execution report type from Pay with ARAF
  lock_version        int NOT NULL DEFAULT 0,
  received_at         timestamptz NOT NULL,
  decided_at          timestamptz,
  updated_at          timestamptz NOT NULL
);
CREATE INDEX pwa_cases_stage_idx ON pwa_cases(stage, received_at);

-- Every action on a case (append-only).
CREATE TABLE pwa_case_events (
  id          bigserial PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES pwa_cases(id),
  action      text NOT NULL,
  from_stage  text,
  to_stage    text,
  actor_id    uuid REFERENCES staff(id),
  actor_name  text NOT NULL,
  actor_role  text,
  note        text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX pwa_case_events_case_idx ON pwa_case_events(case_id, id);

-- Execution reports received from Pay with ARAF (append-only; de-duplicated by event id).
CREATE TABLE pwa_execution_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      text NOT NULL UNIQUE,
  case_id       uuid NOT NULL REFERENCES pwa_cases(id),
  type          text NOT NULL,
  sequence      int NOT NULL,
  occurred_at   timestamptz NOT NULL,
  data          jsonb NOT NULL,                          -- operational references only (no BVN)
  received_at   timestamptz NOT NULL
);
CREATE INDEX pwa_execution_reports_case_idx ON pwa_execution_reports(case_id, sequence);

-- Signed status callbacks to Pay with ARAF (durable, retried by the worker like notification_outbox).
CREATE TABLE pwa_callback_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES pwa_cases(id),
  event_id         text NOT NULL UNIQUE,
  sequence         int NOT NULL,
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD')),
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 10,
  next_attempt_at  timestamptz NOT NULL,
  locked_at        timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL,
  sent_at          timestamptz
);
CREATE INDEX pwa_callback_outbox_due_idx ON pwa_callback_outbox(next_attempt_at) WHERE status IN ('PENDING','FAILED');

-- Single-use sign-in codes for Pay with ARAF's admin portal (60 seconds, stored as an HMAC).
CREATE TABLE pwa_sso_codes (
  code_hash     text PRIMARY KEY,
  staff_id      uuid NOT NULL REFERENCES staff(id),
  session_id    uuid NOT NULL,
  redirect_uri  text NOT NULL,
  auth_time     timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL
);

CREATE TRIGGER pwa_case_events_append_only BEFORE UPDATE OR DELETE ON pwa_case_events FOR EACH ROW EXECUTE FUNCTION fi_append_only();
CREATE TRIGGER pwa_execution_reports_append_only BEFORE UPDATE OR DELETE ON pwa_execution_reports FOR EACH ROW EXECUTE FUNCTION fi_append_only();
CREATE TRIGGER pwa_cases_no_delete BEFORE DELETE ON pwa_cases FOR EACH ROW EXECUTE FUNCTION fi_append_only();
CREATE SEQUENCE pwa_ref_seq START 1;
