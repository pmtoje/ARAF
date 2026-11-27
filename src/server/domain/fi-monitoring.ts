/**
 * Financial Intelligence administration (brief §30): integration monitoring and usage, from ARAF's own records
 * (fi_analyses, fi_statements, fi_api_calls). Nothing here calls Periculum. API charges are not shown: no
 * commercial pricing has been confirmed, and the brief forbids inventing it.
 */
import type { Db } from "../db";

export interface FiMonitoring {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  pendingStatements: number;
  runningAnalyses: number;
  analyses: Record<string, number>;
  turnaround: { medianMinutes: number | null; p90Minutes: number | null; sample: number };
  usage: { statementsProcessed: number; analysisRequests: number; apiSuccess: number; apiFailed: number; apiAmbiguous: number; billableSubmissions: number; duplicatesPrevented: number; reused: number };
  errorCategories: { category: string; count: number }[];
  bySource: { source: string; analyses: number }[];
}

export async function fiMonitoring(q: Db, sinceDays = 30): Promise<FiMonitoring> {
  const since = `now() - interval '${Math.max(1, Math.min(365, Math.floor(sinceDays)))} days'`;
  const one = async <T>(sql: string) => (await q.query(sql)).rows[0] as T;
  const [last, pend, statuses, tat, usage, calls, errs, src] = await Promise.all([
    one<{ ok: Date | null; bad: Date | null }>(
      "SELECT max(created_at) FILTER (WHERE outcome = 'SUCCESS') AS ok, max(created_at) FILTER (WHERE outcome <> 'SUCCESS') AS bad FROM fi_api_calls",
    ),
    one<{ st: string; an: string }>(
      "SELECT (SELECT count(*) FROM fi_statements s JOIN fi_analyses a ON a.id = s.analysis_id WHERE a.superseded_at IS NULL AND s.status IN ('PENDING','SUBMITTING','SUBMISSION_UNCERTAIN','UPLOADED','PROCESSING')) AS st, (SELECT count(*) FROM fi_analyses WHERE status IN ('QUEUED','PROCESSING')) AS an",
    ),
    q.query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM fi_analyses WHERE created_at >= ${since} GROUP BY status`),
    one<{ med: number | null; p90: number | null; n: string }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at) / 60) AS med,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at) / 60) AS p90, count(*) AS n
         FROM fi_analyses WHERE status = 'COMPLETED' AND completed_at IS NOT NULL AND created_at >= ${since}`,
    ),
    one<{ processed: string; requests: string; dup: string; reused: string }>(
      `SELECT (SELECT count(*) FROM fi_statements WHERE status = 'PROCESSED' AND created_at >= ${since}) AS processed,
              (SELECT count(*) FROM fi_analyses WHERE created_at >= ${since}) AS requests,
              (SELECT count(*) FROM fi_statements WHERE status = 'DUPLICATE' AND created_at >= ${since}) AS dup,
              (SELECT count(*) FROM fi_statements WHERE status = 'REUSED' AND created_at >= ${since}) AS reused`,
    ),
    one<{ ok: string; bad: string; amb: string; billable: string }>(
      `SELECT count(*) FILTER (WHERE outcome = 'SUCCESS') AS ok, count(*) FILTER (WHERE outcome NOT IN ('SUCCESS','AMBIGUOUS')) AS bad,
              count(*) FILTER (WHERE outcome = 'AMBIGUOUS') AS amb, count(*) FILTER (WHERE billable AND outcome IN ('SUCCESS','AMBIGUOUS')) AS billable
         FROM fi_api_calls WHERE created_at >= ${since}`,
    ),
    q.query<{ category: string; n: string }>(
      `SELECT category, sum(n)::int AS n FROM (
         SELECT error_category AS category, count(*) AS n FROM fi_statements WHERE error_category IS NOT NULL AND created_at >= ${since} GROUP BY 1
         UNION ALL SELECT error_category, count(*) FROM fi_api_calls WHERE error_category IS NOT NULL AND created_at >= ${since} GROUP BY 1) x
       GROUP BY category ORDER BY n DESC LIMIT 12`,
    ),
    q.query<{ source: string; n: string }>(`SELECT source, count(*) AS n FROM fi_analyses WHERE created_at >= ${since} GROUP BY source`),
  ]);
  return {
    lastSuccessAt: last.ok,
    lastFailureAt: last.bad,
    pendingStatements: Number(pend.st),
    runningAnalyses: Number(pend.an),
    analyses: Object.fromEntries(statuses.rows.map((r) => [r.status, Number(r.n)])),
    turnaround: { medianMinutes: tat.med === null ? null : Math.round(Number(tat.med)), p90Minutes: tat.p90 === null ? null : Math.round(Number(tat.p90)), sample: Number(tat.n) },
    usage: {
      statementsProcessed: Number(usage.processed),
      analysisRequests: Number(usage.requests),
      apiSuccess: Number(calls.ok),
      apiFailed: Number(calls.bad),
      apiAmbiguous: Number(calls.amb),
      billableSubmissions: Number(calls.billable),
      duplicatesPrevented: Number(usage.dup),
      reused: Number(usage.reused),
    },
    errorCategories: errs.rows.map((r) => ({ category: r.category, count: Number(r.n) })),
    bySource: src.rows.map((r) => ({ source: r.source, analyses: Number(r.n) })),
  };
}
