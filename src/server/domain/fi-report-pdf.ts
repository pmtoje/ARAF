/**
 * Credit Risk Report PDF (pure rendering; the caller supplies saved figures). Brand: The Alternative Bank charcoal
 * and yellow. Page 1 is the decision page (risk grade, key figures, DSR against the 30% limit, recommendation,
 * key risks and mitigants); the following pages hold the evidence (risk indicators, monthly activity, accounts,
 * consolidation, analyst review, limitations). Account numbers are masked. Standard PDF fonts only (no ₦ glyph:
 * amounts read "NGN").
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { formatKobo } from "../money";
import { formatLagos } from "../time";
import { pdfSafe } from "./closing-pdfs";
import type { AnalysisRow, StatementRow } from "./statement-analysis";
import type { FinancialIntelligence } from "./financial-intelligence";
import type { Recommendation } from "./credit-recommendation";
import type { ReviewAdjustment } from "./fi-governance";
import { CATEGORY_LABELS, type RiskLevel, type RiskProfile } from "./fi-risk";

export const REPORT_VERSION = "araf-credit-risk-report@2";

export interface ReportData {
  ref: string;
  customerName: string;
  customerType: string;
  product: string;
  daoCode: string | null;
  analysis: Pick<AnalysisRow, "version" | "status" | "source" | "vendor_environment" | "created_at" | "completed_at">;
  statements: Pick<StatementRow, "filename" | "status" | "error_message">[];
  intelligence: FinancialIntelligence | null;
  recommendation: Recommendation | null;
  risk: RiskProfile | null;
  review: { kind: string; actorName: string; actorRole: string; at: Date; reason: string | null; adjustments: ReviewAdjustment[] } | null;
  generatedAt: Date;
}

// ── palette ──────────────────────────────────────────────────────────────
const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  ink: hex("#1A1D21"),
  muted: hex("#6B7280"),
  faint: hex("#9AA1AC"),
  line: hex("#E3E5E8"),
  panel: hex("#F5F6F8"),
  charcoal: hex("#1F2933"),
  charcoalSoft: hex("#C9CED6"),
  yellow: hex("#FFC20E"),
  white: rgb(1, 1, 1),
  blue: hex("#257DE0"),
  orange: hex("#F47230"),
};
const LEVEL: Record<RiskLevel, { fg: RGB; bg: RGB; label: string }> = {
  HIGH: { fg: hex("#B42318"), bg: hex("#FDECEA"), label: "HIGH" },
  WATCH: { fg: hex("#9A5B00"), bg: hex("#FFF2DB"), label: "WATCH" },
  LOW: { fg: hex("#1E7B34"), bg: hex("#E7F5EA"), label: "LOW" },
  NOT_REPORTED: { fg: hex("#6B7280"), bg: hex("#EEF0F3"), label: "N/R" },
};
const GRADE: Record<string, { fg: RGB; bg: RGB }> = {
  LOW: { fg: C.white, bg: hex("#1E7B34") },
  MODERATE: { fg: C.ink, bg: hex("#FFC20E") },
  ELEVATED: { fg: C.white, bg: hex("#C2620A") },
  HIGH: { fg: C.white, bg: hex("#B42318") },
};

const A4: [number, number] = [595.28, 841.89];
const M = 40;
const W = A4[0] - 2 * M;
const money = (k: number | null | undefined, whole = false) => {
  if (k === null || k === undefined) return "—";
  const s = pdfSafe(formatKobo(k));
  return whole ? s.replace(/\.00$/, "") : s;
};

class Doc {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(
    readonly pdf: PDFDocument,
    readonly f: PDFFont,
    readonly b: PDFFont,
    readonly logo: PDFImage | null,
    readonly footer: string,
  ) {}

  newPage(header = true) {
    this.page = this.pdf.addPage(A4);
    this.pageNo++;
    this.page.drawRectangle({ x: 0, y: A4[1] - 5, width: A4[0], height: 5, color: C.yellow });
    if (header) {
      this.text("CREDIT RISK REPORT", M, A4[1] - 30, 8, this.b, C.muted, 1.2);
      this.logoAt(A4[0] - M, A4[1] - 16, 18);
      this.page.drawLine({ start: { x: M, y: A4[1] - 46 }, end: { x: A4[0] - M, y: A4[1] - 46 }, thickness: 0.5, color: C.line });
      this.y = A4[1] - 62;
    }
    const t = pdfSafe(`${this.footer}`);
    this.text(t, M, 24, 7, this.f, C.faint);
    const pn = `Page ${this.pageNo}`;
    this.text(pn, A4[0] - M - this.f.widthOfTextAtSize(pn, 7), 24, 7, this.f, C.faint);
  }
  logoAt(right: number, top: number, h: number) {
    if (!this.logo) return;
    const w = (this.logo.width / this.logo.height) * h;
    this.page.drawImage(this.logo, { x: right - w, y: top - h + 2, width: w, height: h });
  }
  text(s: string, x: number, y: number, size: number, font = this.f, color: RGB = C.ink, spacing = 0) {
    const t = pdfSafe(s);
    if (!spacing) return this.page.drawText(t, { x, y, size, font, color });
    let cx = x;
    for (const ch of t) {
      this.page.drawText(ch, { x: cx, y, size, font, color });
      cx += font.widthOfTextAtSize(ch, size) + spacing;
    }
  }
  right(s: string, xr: number, y: number, size: number, font = this.f, color: RGB = C.ink) {
    const t = pdfSafe(s);
    this.page.drawText(t, { x: xr - font.widthOfTextAtSize(t, size), y, size, font, color });
  }
  wrap(s: string, size: number, width: number, font = this.f): string[] {
    const out: string[] = [];
    let cur = "";
    for (const w of pdfSafe(s).split(" ")) {
      const n = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(n, size) > width && cur) {
        out.push(cur);
        cur = w;
      } else cur = n;
    }
    if (cur) out.push(cur);
    return out;
  }
  fit(s: string, size: number, width: number, font = this.f) {
    let t = pdfSafe(s);
    while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = t.slice(0, -2) + "…";
    return t;
  }
  /** Largest size (down to min) at which s fits in width. */
  fitSize(s: string, width: number, max: number, min: number, font = this.b) {
    let z = max;
    while (z > min && font.widthOfTextAtSize(pdfSafe(s), z) > width) z -= 0.5;
    return z;
  }
  /** Rounded rectangle (four arcs approximated with an SVG path). */
  round(x: number, y: number, w: number, h: number, r: number, color: RGB, border?: RGB) {
    const p = `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`;
    this.page.drawSvgPath(p, { x, y: y + h, color, borderColor: border, borderWidth: border ? 0.6 : 0 });
  }
  pill(s: string, x: number, yBase: number, fg: RGB, bg: RGB, size = 7) {
    const t = pdfSafe(s);
    const w = this.b.widthOfTextAtSize(t, size) + 10;
    this.round(x, yBase - 3, w, size + 6, (size + 6) / 2, bg);
    this.page.drawText(t, { x: x + 5, y: yBase, size, font: this.b, color: fg });
    return w;
  }
  ensure(h: number) {
    if (this.y - h < 48) this.newPage();
  }
  section(title: string, sub?: string) {
    this.ensure(46);
    this.y -= 10;
    this.page.drawRectangle({ x: M, y: this.y - 13, width: 3, height: 14, color: C.yellow });
    this.text(title, M + 9, this.y - 11, 12.5, this.b);
    if (sub) this.right(sub, A4[0] - M, this.y - 10, 7.5, this.f, C.muted);
    this.y -= 22;
  }
  para(s: string, size = 9, color: RGB = C.ink, indent = 0, gap = 3) {
    for (const l of this.wrap(s, size, W - indent)) {
      this.ensure(size + 4);
      this.text(l, M + indent, this.y - size, size, this.f, color);
      this.y -= size + 3.5;
    }
    this.y -= gap;
  }
  /** Label/value rows with zebra striping. */
  kv(rows: [string, string, boolean?][]) {
    rows.forEach(([k, v, strong], i) => {
      this.ensure(17);
      if (i % 2 === 0) this.page.drawRectangle({ x: M, y: this.y - 16, width: W, height: 16, color: C.panel });
      this.text(this.fit(k, 8.5, W * 0.6), M + 8, this.y - 11.5, 8.5, this.f, C.muted);
      this.right(v, A4[0] - M - 8, this.y - 11.5, 8.5, strong ? this.b : this.f, C.ink);
      this.y -= 16;
    });
    this.y -= 6;
  }
  table(head: string[], rows: string[][], widths: number[], numeric: boolean[]) {
    const total = widths.reduce((a, c) => a + c, 0);
    const ws = widths.map((w) => (w / total) * W);
    const drawRow = (cells: string[], font: PDFFont, color: RGB, size: number, bg?: RGB) => {
      this.ensure(16);
      if (bg) this.page.drawRectangle({ x: M, y: this.y - 15, width: W, height: 15, color: bg });
      let x = M;
      cells.forEach((c, i) => {
        const t = this.fit(c, size, ws[i] - 10, font);
        if (numeric[i]) this.right(t, x + ws[i] - 6, this.y - 10.5, size, font, color);
        else this.text(t, x + 6, this.y - 10.5, size, font, color);
        x += ws[i];
      });
      this.y -= 15;
    };
    drawRow(head, this.b, C.muted, 7.5, C.panel);
    rows.forEach((r, i) => drawRow(r, this.f, C.ink, 8.5, i % 2 ? C.panel : undefined));
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4[0] - M, y: this.y }, thickness: 0.4, color: C.line });
    this.y -= 8;
  }
}

/** Page 1: the decision page. */
function cover(d: Doc, r: ReportData) {
  const p = d.page;
  const rec = r.recommendation;
  const risk = r.risk;
  // Charcoal band
  const bandH = 118;
  p.drawRectangle({ x: 0, y: A4[1] - 5 - bandH, width: A4[0], height: bandH, color: C.charcoal });
  if (d.logo) {
    const lh = 24;
    const lw = (d.logo.width / d.logo.height) * lh;
    d.round(A4[0] - M - lw - 24, A4[1] - 54, lw + 24, 36, 6, C.white);
    d.logoAt(A4[0] - M - 12, A4[1] - 24, lh);
  }
  d.text("CREDIT RISK REPORT", M, A4[1] - 36, 8.5, d.b, C.yellow, 1.6);
  const nameSize = d.fitSize(r.customerName, W - 150, 22, 14);
  d.text(d.fit(r.customerName, nameSize, W - 150, d.b), M, A4[1] - 64, nameSize, d.b, C.white);
  d.text(d.fit(`${r.product} · ${r.customerType} · ${r.ref}`, 10, W - 20), M, A4[1] - 84, 10, d.f, C.charcoalSoft);
  d.text(`Automatic Statement Analysis v${r.analysis.version} · ${r.analysis.source === "FIXTURE" ? "simulated test data" : `Periculum Insights (${r.analysis.vendor_environment})`} · ${formatLagos(r.analysis.completed_at ?? r.analysis.created_at)}`, M, A4[1] - 104, 8, d.f, C.charcoalSoft);
  d.y = A4[1] - 5 - bandH - 14;

  if (r.analysis.source === "FIXTURE") {
    d.round(M, d.y - 20, W, 20, 4, LEVEL.HIGH.bg);
    d.text("TEST DATA: produced by ARAF's simulated Periculum service, not by Periculum. Not for a credit decision.", M + 10, d.y - 13.5, 8, d.b, LEVEL.HIGH.fg);
    d.y -= 30;
  }

  // Facts strip
  const facts: [string, string][] = [
    ["APPLICATION", r.ref],
    ["DAO CODE", r.daoCode || "—"],
    ["REQUESTED", rec ? `${money(rec.requested.principalKobo, true)} / ${rec.requested.tenorMonths ?? "—"} mo` : "—"],
    ["SEEDFI", rec?.seedfi ? `${rec.seedfi.outcome ?? "—"}${rec.seedfi.score !== null ? ` · ${rec.seedfi.score}` : ""}` : "Not on record"],
  ];
  const fw = W / facts.length;
  d.round(M, d.y - 40, W, 40, 6, C.panel);
  facts.forEach(([k, v], i) => {
    d.text(k, M + 12 + i * fw, d.y - 15, 6.5, d.b, C.muted, 0.8);
    d.text(d.fit(v, 9.5, fw - 18, d.b), M + 12 + i * fw, d.y - 29, 9.5, d.b, C.ink);
    if (i) p.drawLine({ start: { x: M + i * fw, y: d.y - 8 }, end: { x: M + i * fw, y: d.y - 32 }, thickness: 0.5, color: C.line });
  });
  d.y -= 54;

  // Risk grade panel
  const ph = 92;
  d.round(M, d.y - ph, W, ph, 8, C.white, C.line);
  const g = GRADE[risk?.grade ?? "HIGH"];
  d.round(M, d.y - ph, 150, ph, 8, g.bg);
  p.drawRectangle({ x: M + 142, y: d.y - ph, width: 8, height: ph, color: g.bg });
  d.text("RISK GRADE", M + 14, d.y - 22, 7, d.b, g.fg, 1.2);
  const gw = risk ? risk.gradeLabel.replace(" risk", "").toUpperCase() : "N/A";
  d.text(gw, M + 14, d.y - 52, d.fitSize(gw, 122, 24, 12), d.b, g.fg);
  d.text(risk ? `score ${risk.score} · ${risk.indicators.length} indicators` : "No risk profile", M + 14, d.y - 72, 7.5, d.f, g.fg);
  const hx = M + 166;
  const hw = W - 180;
  let hy = d.y - 20;
  for (const l of d.wrap(risk?.headline ?? "Risk profile unavailable.", 11, hw, d.b).slice(0, 2)) {
    d.text(l, hx, hy, 11, d.b, C.ink);
    hy -= 15;
  }
  if (rec) {
    const line = `Recommendation: ${rec.outcomeLabel}${rec.dsr.percent ? ` · DSR ${Number(rec.dsr.percent).toFixed(2)}% against ${rec.dsr.thresholdPercent}%` : ""}`;
    for (const l of d.wrap(line, 8.5, hw).slice(0, 2)) {
      d.text(l, hx, hy - 2, 8.5, d.f, C.muted);
      hy -= 11;
    }
  }
  if (risk) {
    let px = hx;
    const py = d.y - ph + 18;
    px += d.pill(`${risk.counts.high} HIGH`, px, py, LEVEL.HIGH.fg, LEVEL.HIGH.bg, 7.5) + 6;
    px += d.pill(`${risk.counts.watch} WATCH`, px, py, LEVEL.WATCH.fg, LEVEL.WATCH.bg, 7.5) + 6;
    px += d.pill(`${risk.counts.low} LOW`, px, py, LEVEL.LOW.fg, LEVEL.LOW.bg, 7.5) + 6;
    if (risk.counts.notReported) d.pill(`${risk.counts.notReported} NOT REPORTED`, px, py, LEVEL.NOT_REPORTED.fg, LEVEL.NOT_REPORTED.bg, 7.5);
  }
  d.y -= ph + 14;

  // KPI tiles
  const tiles: [string, string, string][] = [
    ["REQUESTED", money(rec?.requested.principalKobo, true), rec?.requested.tenorMonths ? `over ${rec.requested.tenorMonths} months` : ""],
    ["INDICATIVE ELIGIBLE", money(rec?.maxEligiblePrincipalKobo, true), "at the approved DSR"],
    ["RECOMMENDED", money(rec?.recommendedPrincipalKobo, true), rec?.outcomeLabel ?? ""],
    ["MONTHLY CAPACITY", money(rec?.availableCapacityKobo, true), "available for this facility"],
  ];
  const gap = 8;
  const tw = (W - gap * 3) / 4;
  tiles.forEach(([k, v, s], i) => {
    const x = M + i * (tw + gap);
    d.round(x, d.y - 58, tw, 58, 6, C.panel);
    p.drawRectangle({ x, y: d.y - 58, width: 3, height: 58, color: i === 2 ? C.yellow : C.line });
    d.text(k, x + 11, d.y - 16, 6.5, d.b, C.muted, 0.6);
    d.text(d.fit(v, 13, tw - 18, d.b), x + 11, d.y - 35, 13, d.b, C.ink);
    d.text(d.fit(s, 7, tw - 18), x + 11, d.y - 49, 7, d.f, C.muted);
  });
  d.y -= 74;

  // DSR gauge
  if (rec?.dsr.percent && rec.dsr.thresholdPercent) {
    const dsr = Number(rec.dsr.percent);
    const lim = Number(rec.dsr.thresholdPercent);
    const max = Math.max(50, Math.ceil((Math.max(dsr, lim) * 1.25) / 10) * 10);
    d.text("Debt service ratio", M, d.y - 10, 10, d.b);
    d.right(`${dsr.toFixed(2)}% of ${lim}% limit`, A4[0] - M, d.y - 10, 10, d.b, rec.dsr.pass === false ? LEVEL.HIGH.fg : C.ink);
    const by = d.y - 34;
    d.round(M, by, W, 12, 6, C.panel);
    const fill = Math.max(12, Math.min(W, (dsr / max) * W));
    const col = rec.dsr.pass === false ? LEVEL.HIGH.fg : dsr > lim * 0.8 ? hex("#C2620A") : hex("#1E7B34");
    d.round(M, by, fill, 12, 6, col);
    const lx = M + (lim / max) * W;
    p.drawLine({ start: { x: lx, y: by - 5 }, end: { x: lx, y: by + 17 }, thickness: 1.6, color: C.charcoal });
    d.text(`${lim}% limit`, lx - 16, by - 14, 7, d.b, C.charcoal);
    d.text("0%", M, by - 14, 7, d.f, C.muted);
    d.right(`${max}%`, A4[0] - M, by - 14, 7, d.f, C.muted);
    d.text(
      d.fit(`Proposed ${money(rec.proposedMonthlyKobo)} + existing ${money(rec.obligations.usedMonthlyKobo)} a month against ${rec.income.basis.toLowerCase()} of ${money(rec.income.monthlyKobo)}.`, 8, W),
      M,
      by - 28,
      8,
      d.f,
      C.muted,
    );
    d.y = by - 42;
  }

  // Recommendation and commentary
  if (rec) {
    const lines = rec.commentary.flatMap((c) => d.wrap(c, 8.5, W - 24));
    const shown = lines.slice(0, 7);
    const h = 30 + shown.length * 12;
    d.round(M, d.y - h, W, h, 6, C.white, C.line);
    d.text("Automated recommendation", M + 12, d.y - 17, 9.5, d.b);
    d.right(rec.outcomeLabel, A4[0] - M - 12, d.y - 17, 9.5, d.b, rec.outcome === "WITHIN_CAPACITY" ? hex("#1E7B34") : rec.outcome === "EXCEEDS_DSR" || rec.outcome === "UNABLE_TO_ASSESS" ? LEVEL.HIGH.fg : hex("#9A5B00"));
    shown.forEach((l, i) => d.text(l, M + 12, d.y - 33 - i * 12, 8.5, d.f, C.ink));
    d.y -= h + 12;
  }

  // Key risks and mitigants
  if (risk) {
    const colW = (W - 12) / 2;
    const block = (x: number, title: string, items: string[], tone: { fg: RGB; bg: RGB }) => {
      let yy = d.y - 16;
      d.text(title, x + 10, yy, 9, d.b, tone.fg);
      yy -= 14;
      for (const it of items.slice(0, 5)) {
        const ls = d.wrap(it, 7.8, colW - 26).slice(0, 2);
        p.drawCircle({ x: x + 13, y: yy + 2.6, size: 1.8, color: tone.fg });
        ls.forEach((l, i) => d.text(l, x + 20, yy - i * 10, 7.8, d.f, C.ink));
        yy -= ls.length * 10 + 4;
      }
      return d.y - yy;
    };
    const need = (items: string[]) => 34 + items.slice(0, 5).reduce((t, it) => t + Math.min(2, d.wrap(it, 7.8, colW - 26).length) * 10 + 4, 0);
    const kr = risk.keyRisks.length ? risk.keyRisks : ["No high or watch signals."];
    const mg = risk.mitigants.length ? risk.mitigants : ["None identified."];
    const space = Math.min(d.y - 60, Math.max(need(kr), need(mg)));
    d.round(M, d.y - space, colW, space, 6, LEVEL.HIGH.bg);
    d.round(M + colW + 12, d.y - space, colW, space, 6, LEVEL.LOW.bg);
    block(M, "Key risks", kr, LEVEL.HIGH);
    block(M + colW + 12, "Mitigants", mg, LEVEL.LOW);
    d.y -= space + 6;
  }
}

function riskIndicators(d: Doc, risk: RiskProfile) {
  d.section("Risk indicators", `${risk.version} · thresholds ${risk.thresholdsStatus.toLowerCase()}`);
  for (const cat of Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]) {
    const items = risk.indicators.filter((i) => i.category === cat);
    if (!items.length) continue;
    d.ensure(40);
    d.text(CATEGORY_LABELS[cat].toUpperCase(), M, d.y - 9, 7, d.b, C.muted, 0.8);
    d.y -= 16;
    for (const i of items) {
      const ev = d.wrap(`${i.evidence} (${i.source})`, 7.5, W - 190).slice(0, 2);
      const h = 18 + ev.length * 9.5;
      d.ensure(h + 2);
      d.round(M, d.y - h, W, h, 4, C.white, C.line);
      const lv = LEVEL[i.level];
      d.pill(lv.label, M + 8, d.y - 14, lv.fg, lv.bg, 6.5);
      d.text(d.fit(i.label, 9, W - 230, d.b), M + 60, d.y - 14, 9, d.b);
      d.right(d.fit(i.value, 9, 150, d.b), A4[0] - M - 10, d.y - 14, 9, d.b, i.level === "HIGH" ? lv.fg : C.ink);
      ev.forEach((l, k) => d.text(l, M + 60, d.y - 25 - k * 9.5, 7.5, d.f, C.muted));
      d.y -= h + 4;
    }
    d.y -= 4;
  }
}

function monthlyChart(d: Doc, fi: FinancialIntelligence) {
  const months = fi.months.filter((m) => fi.assessmentMonths.includes(m.month));
  if (months.length < 2) return;
  const H = 120;
  d.ensure(H + 90); // heading, legend, chart and axis stay together
  d.section("Monthly inflow and outflow", "adjusted figures, assessment months");
  const top = d.y - 14;
  const base = top - H;
  const max = Math.max(...months.flatMap((m) => [m.adjustedInflowKobo, m.adjustedOutflowKobo]), 1);
  // legend
  d.page.drawRectangle({ x: M, y: top + 2, width: 8, height: 8, color: C.blue });
  d.text("Adjusted inflow", M + 12, top + 3, 7.5, d.f, C.muted);
  d.page.drawRectangle({ x: M + 90, y: top + 2, width: 8, height: 8, color: C.orange });
  d.text("Adjusted outflow", M + 102, top + 3, 7.5, d.f, C.muted);
  d.right(`Highest month ${money(max, true)}`, A4[0] - M, top + 3, 7.5, d.f, C.muted);
  // gridlines
  for (let k = 1; k <= 3; k++) {
    const gy = base + (H * k) / 4;
    d.page.drawLine({ start: { x: M, y: gy }, end: { x: A4[0] - M, y: gy }, thickness: 0.3, color: C.line });
  }
  d.page.drawLine({ start: { x: M, y: base }, end: { x: A4[0] - M, y: base }, thickness: 0.8, color: C.faint });
  const band = W / months.length;
  const bw = Math.min(22, (band - 16) / 2);
  months.forEach((m, i) => {
    const x0 = M + i * band + (band - (2 * bw + 2)) / 2;
    const hi = (H * m.adjustedInflowKobo) / max;
    const ho = (H * m.adjustedOutflowKobo) / max;
    if (hi > 0) d.round(x0, base, bw, Math.max(hi, 2), Math.min(3, hi / 2), C.blue);
    if (ho > 0) d.round(x0 + bw + 2, base, bw, Math.max(ho, 2), Math.min(3, ho / 2), C.orange);
    const lab = m.month;
    d.text(lab, x0 + bw + 1 - d.f.widthOfTextAtSize(lab, 7) / 2, base - 11, 7, d.f, C.muted);
  });
  d.y = base - 22;
  d.table(
    ["Month", "Gross inflow", "Adjusted inflow", "Adjusted outflow", "Salary", "Loan repayments", "Net"],
    months.map((m) => [m.month, money(m.grossInflowKobo, true), money(m.adjustedInflowKobo, true), money(m.adjustedOutflowKobo, true), money(m.salaryKobo, true), money(m.loanRepaymentKobo, true), money(m.netCashFlowKobo, true)]),
    [1.3, 2, 2, 2, 1.7, 1.9, 1.9],
    [false, true, true, true, true, true, true],
  );
}

export async function buildFinancialReportPdf(r: ReportData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`Credit Risk Report ${r.ref}`));
  pdf.setAuthor("The Alternative Bank · ARAF");
  pdf.setSubject("Credit Risk Report from Automatic Statement Analysis");
  pdf.setProducer(REPORT_VERSION);
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const b = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo: PDFImage | null = null;
  try {
    logo = await pdf.embedPng(await readFile(path.join(process.cwd(), "templates", "closing", "altbank.png")));
  } catch {
    logo = null;
  }
  const d = new Doc(pdf, f, b, logo, `The Alternative Bank · ARAF · ${r.ref} · analysis v${r.analysis.version} · ${REPORT_VERSION} · Confidential`);
  d.newPage(false);
  cover(d, r);

  d.newPage();
  const fi = r.intelligence;
  const rec = r.recommendation;
  if (r.risk) riskIndicators(d, r.risk);
  if (fi) monthlyChart(d, fi);

  if (fi) {
    d.section("Accounts and statements", `${fi.statementsAnalysed} of ${fi.statementsTotal} analysed · ${fi.uniqueAccounts} account(s)`);
    d.table(
      ["Bank and account", "Holder", "Ownership", "Period", "Gross inflow", "Gross outflow"],
      fi.accounts.map((a) => [`${a.bankName ?? "Bank not stated"} ${a.accountNumberMasked ?? ""}`, a.accountName ?? "—", a.ownership.toLowerCase(), `${a.periodStart ?? "—"} to ${a.periodEnd ?? "—"}`, money(a.grossInflowKobo, true), money(a.grossOutflowKobo, true)]),
      [2.6, 2.2, 1.3, 2.6, 1.8, 1.8],
      [false, false, false, false, true, true],
    );
    d.table(
      ["Statement file", "Status", "Note"],
      r.statements.map((s) => [s.filename, s.status.toLowerCase().replace(/_/g, " "), s.error_message ?? ""]),
      [3.2, 1.6, 5],
      [false, false, false],
    );
    d.section("Consolidated financial position");
    const t = fi.totals;
    d.kv([
      ["Gross inflow, all accounts", money(t.grossInflowKobo)],
      ["Less transfers between the applicant's own accounts", money(t.internalTransfersKobo)],
      ["Less duplicate transactions", money(t.duplicatesExcludedKobo)],
      ["Less loan proceeds", money(t.loanProceedsKobo)],
      ["Less unmatched self-transfers and inflows to unverified accounts", money(t.unmatchedSelfTransfersKobo + t.unverifiedAccountInflowKobo)],
      ["Adjusted external inflow", money(t.adjustedExternalInflowKobo), true],
      ["Average monthly adjusted inflow", money(fi.monthly.adjustedInflowKobo), true],
      ["Average monthly net cash flow", money(fi.monthly.netCashFlowKobo)],
      ...(fi.customerType === "SALARIED" ? ([["Verified monthly salary", money(fi.salary.verifiedMonthlyKobo), true]] as [string, string, boolean][]) : []),
      ["Loan repayments seen in the statements (monthly)", money(fi.obligations.detectedMonthlyKobo)],
    ]);
  }

  if (rec) {
    d.ensure(190); // keep the affordability block on one page
    d.section("Affordability", rec.engine ? `${rec.version} · ${rec.engine.engineVersion}` : rec.version);
    d.kv([
      [rec.income.basis, money(rec.income.monthlyKobo)],
      [`Existing monthly obligations (${rec.obligations.source.toLowerCase()})`, money(rec.obligations.usedMonthlyKobo)],
      ["Proposed monthly repayment", money(rec.proposedMonthlyKobo)],
      ["Calculated DSR / approved threshold", rec.dsr.percent ? `${rec.dsr.percent}% / ${rec.dsr.thresholdPercent}%` : "Not calculated", true],
      ["DSCR", "Not applicable to this product's approved methodology"],
      ["Available monthly capacity", money(rec.availableCapacityKobo)],
      [`Indicative eligible financing over ${rec.requested.tenorMonths ?? "—"} months`, money(rec.maxEligiblePrincipalKobo), true],
    ]);
    if (rec.obligations.reconciliationNote) d.para(rec.obligations.reconciliationNote, 8, C.muted);
  }

  if (r.review) {
    const label = r.review.kind === "ADJUSTED" ? "Adjusted the automated figures" : r.review.kind === "MANUAL" ? "Manual Financial Assessment (approved exception)" : "Confirmed the automated figures";
    d.section("Credit analyst review", formatLagos(r.review.at));
    d.para(`${label} · ${r.review.actorName} (${r.review.actorRole.replace(/_/g, " ").toLowerCase()})`, 9.5, C.ink);
    if (r.review.adjustments.length)
      d.table(
        ["Figure", "Automated", "Analyst"],
        r.review.adjustments.map((a) => [a.label, a.field === "TENOR" ? `${a.original ?? "—"} months` : money(a.original), a.field === "TENOR" ? `${a.adjusted ?? "—"} months` : money(a.adjusted)]),
        [4, 2, 2],
        [false, true, true],
      );
    if (r.review.reason) d.para(`Reason: ${r.review.reason}`, 8.5, C.muted);
  }

  if (fi) {
    const items = [...fi.exceptions, ...(rec?.policyFlags ?? [])];
    d.section("Observations and outstanding conditions");
    if (!items.length && !rec?.conditions.length) d.para("No exceptions were identified.", 9, C.muted);
    for (const e of items) {
      d.ensure(30);
      const lv = e.severity === "BLOCKING" ? LEVEL.HIGH : e.severity === "MATERIAL" ? LEVEL.WATCH : LEVEL.NOT_REPORTED;
      d.pill(e.severity, M, d.y - 10, lv.fg, lv.bg, 6.5);
      d.text(d.fit(e.type.replace(/_/g, " ").toLowerCase(), 9, W - 90, d.b), M + 70, d.y - 10, 9, d.b);
      d.y -= 16;
      d.para(`${e.reason}${e.resolution ? ` Required: ${e.resolution}` : ""}`, 8.5, C.ink, 70);
    }
    for (const c of rec?.conditions ?? []) if (!items.some((e) => c.includes(e.reason))) d.para(`Condition: ${c}`, 8.5, C.ink);
  }

  d.section("Limitations");
  d.para(
    `Decision support only: not a credit approval. Calculated from the bank statements supplied for this application, analysed by ${r.analysis.source === "FIXTURE" ? "ARAF's simulated service (test data)" : "Periculum Insights"}, and the bank's approved affordability rules (30% income DSR). Risk thresholds: ${r.risk?.thresholdsStatus ?? "n/a"}. Fields Periculum did not return are shown as not reported, never as clean. Account numbers are masked. Viewing this report does not call Periculum. Generated ${formatLagos(r.generatedAt)}.`,
    8,
    C.muted,
  );
  return Buffer.from(await pdf.save());
}
