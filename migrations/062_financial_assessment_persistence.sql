-- Phase 6: persistence and workflow for Automatic Statement Analysis.
-- * fi_reviews: every credit-analyst confirmation or adjustment of the automated assessment. The original
--   Periculum-derived figures stay on fi_analyses.result; adjusted values, reason, analyst and time are kept here.
-- * fi_analyses.report_document_id: the current Financial Assessment Report (documents keeps every version).
-- * fi_analyses.relied_on_*: the analysis a recorded credit decision relied on. It is never overwritten or reused
--   as "current" after its statements change.
-- * policy_exceptions type MANUAL_ASSESSMENT: the controlled Manual Financial Assessment exception.

CREATE TABLE fi_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id     uuid REFERENCES fi_analyses(id),
  application_id  uuid NOT NULL REFERENCES applications(id),
  assessment_id   uuid NOT NULL REFERENCES retail_assessments(id),
  kind            text NOT NULL CHECK (kind IN ('CONFIRMED','ADJUSTED','MANUAL')),
  adjustments     jsonb NOT NULL DEFAULT '[]',
  reason          text,
  actor_id        uuid NOT NULL REFERENCES staff(id),
  actor_role      text NOT NULL,
  created_at      timestamptz NOT NULL,
  CHECK (kind <> 'ADJUSTED' OR length(trim(coalesce(reason, ''))) >= 10),
  CHECK (kind = 'MANUAL' OR analysis_id IS NOT NULL)
);
CREATE INDEX fi_reviews_app_idx ON fi_reviews(application_id, created_at DESC);

ALTER TABLE fi_analyses
  ADD COLUMN report_document_id uuid REFERENCES documents(id),
  ADD COLUMN relied_on_at       timestamptz,
  ADD COLUMN relied_on_task_id  uuid REFERENCES tasks(id);

ALTER TABLE policy_exceptions DROP CONSTRAINT policy_exceptions_type_check;
ALTER TABLE policy_exceptions ADD CONSTRAINT policy_exceptions_type_check CHECK (type IN ('AFS','DSR','DOCUMENT','MANUAL_ASSESSMENT'));
