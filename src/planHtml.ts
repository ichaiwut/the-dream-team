import { spawn } from "node:child_process";
import { LogEntry } from "./log.js";
import { computeChecklist } from "./pipeline.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s: string): string {
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

function splitTableRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  return r.split("|").map((c) => c.trim());
}

const TABLE_SEPARATOR_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * A small, dependency-free markdown->HTML renderer, just enough for plan.md
 * as roles/pm.md actually writes it: headings, bullet lists, pipe tables,
 * **bold**, `code`, and plain paragraphs. Not a general markdown parser —
 * extending it is fine as plan.md's shape evolves, but it only has to track
 * what PM is instructed to produce, not arbitrary markdown.
 */
export function mdToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  let html = "";
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>\n";
      inList = false;
    }
  };

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === "") {
      closeList();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html += `<h${level}>${inlineMd(escapeHtml(heading[2]))}</h${level}>\n`;
      i++;
      continue;
    }

    if (trimmed.startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1].trim())) {
      closeList();
      const headerCells = splitTableRow(trimmed);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        bodyRows.push(splitTableRow(lines[i].trim()));
        i++;
      }
      html += "<table><thead><tr>";
      html += headerCells.map((c) => `<th>${inlineMd(escapeHtml(c))}</th>`).join("");
      html += "</tr></thead><tbody>\n";
      for (const row of bodyRows) {
        html += "<tr>" + row.map((c) => `<td>${inlineMd(escapeHtml(c))}</td>`).join("") + "</tr>\n";
      }
      html += "</tbody></table>\n";
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        html += "<ul>\n";
        inList = true;
      }
      html += `<li>${inlineMd(escapeHtml(trimmed.replace(/^[-*]\s+/, "")))}</li>\n`;
      i++;
      continue;
    }

    closeList();
    const para = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("|")
    ) {
      para.push(lines[i].trim());
      i++;
    }
    html += `<p>${inlineMd(escapeHtml(para.join(" ")))}</p>\n`;
  }
  closeList();
  return html;
}

/**
 * Renders the fixed PO->PM->Dev->Reviewer->Tester pipeline (src/pipeline.ts)
 * as an actual flow chart — boxes connected by arrows, colored by status —
 * with the Dev/Reviewer/Tester group visually boxed off and annotated with
 * the fail->retry loop, since that loop (not a straight line) is the one
 * part of the pipeline most worth seeing at a glance.
 */
function buildFlowChart(log: LogEntry[]): string {
  const checklist = computeChecklist(log);
  const byId = new Map(checklist.items.map((it) => [it.id, it]));

  const box = (id: string) => {
    const item = byId.get(id)!;
    const stuck = item.status === "current" && checklist.needsAttention;
    const cls = stuck ? "stuck" : item.status;
    const mark = stuck ? "⚠" : item.status === "done" ? "✓" : item.status === "current" ? "▶" : "";
    return `<div class="step ${cls}"><span class="mark">${mark}</span>${escapeHtml(item.label)}</div>`;
  };
  const arrow = `<div class="arrow">↓</div>`;

  const head = ["spec_fetched", "plan_written", "plan_awaiting_approval"].map(box).join(arrow);
  const loopSteps = ["dev_started", "dev_done", "reviewer_started", "reviewer_done", "tester_started", "tester_done"]
    .map(box)
    .join(arrow);
  const tail = box("final_done");

  const loopBadge =
    checklist.iterationCount > 0
      ? `<div class="loop-badge">↻ วนแก้แล้ว ${checklist.iterationCount} รอบ</div>`
      : "";
  const attentionBadge = checklist.needsAttention
    ? `<div class="attention-badge">⚠ ต้องการให้ PO ตัดสินใจ — ดูคำตอบสุดท้ายของ PM ในเทอร์มินัล</div>`
    : "";

  return `
    <div class="flow">
      ${head}
      ${arrow}
      <div class="loop-group">
        ${loopSteps}
        <div class="loop-back">↩ วนกลับไปสั่ง Dev ใหม่ถ้า Tester ไม่ผ่าน</div>
      </div>
      ${arrow}
      ${tail}
      ${loopBadge}
      ${attentionBadge}
    </div>`;
}

const STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 32px; background: #0f1117; color: #e6e6e6;
    font-family: 'Sarabun', 'Noto Sans Thai', 'Tahoma', system-ui, sans-serif;
    line-height: 1.6;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .meta { color: #9aa0a6; font-size: 0.9rem; margin-bottom: 28px; }
  .banner {
    background: #2a2410; border: 1px solid #e6c84a; color: #f3df8f;
    padding: 12px 16px; border-radius: 8px; margin-bottom: 28px; font-weight: 600;
  }
  h2 { font-size: 1.15rem; margin-top: 28px; color: #7cc7ff; }
  h3 { font-size: 1.0rem; margin-top: 20px; color: #7cc7ff; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 0.92rem; }
  th, td { border: 1px solid #333a45; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #1a1f29; }
  code { background: #1a1f29; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  ul { margin: 8px 0; padding-left: 22px; }
  li { margin: 4px 0; }
  p { margin: 10px 0; }

  .flow { display: flex; flex-direction: column; align-items: center; margin: 24px 0 32px; }
  .step {
    width: 320px; max-width: 90vw; text-align: center; padding: 10px 14px;
    border-radius: 8px; border: 1px solid #333a45; background: #1a1f29; font-size: 0.92rem;
  }
  .step .mark { margin-right: 6px; }
  .step.done { background: #123420; border-color: #2e7d4f; color: #8be3ab; }
  .step.current { background: #3a3110; border-color: #e6c84a; color: #f3df8f; font-weight: 700; }
  .step.stuck { background: #3a1414; border-color: #e65a5a; color: #ff9b9b; font-weight: 700; }
  .step.pending { color: #8a909c; }
  .arrow { color: #5a6270; font-size: 1.1rem; line-height: 1; margin: 2px 0; }
  .loop-group {
    display: flex; flex-direction: column; align-items: center; gap: 0;
    border: 1px dashed #5a6270; border-radius: 10px; padding: 14px 16px 10px;
  }
  .loop-back { color: #9aa0a6; font-size: 0.85rem; margin-top: 8px; }
  .loop-badge, .attention-badge {
    margin-top: 14px; padding: 6px 14px; border-radius: 6px; font-size: 0.9rem;
  }
  .loop-badge { background: #3a3110; color: #f3df8f; }
  .attention-badge { background: #3a1414; color: #ff9b9b; font-weight: 700; }

  .plan-body {
    border: 1px solid #333a45; border-radius: 10px; padding: 18px 22px; background: #141822;
  }
`;

/**
 * Best-effort "open this file in whatever the OS considers the default
 * browser" — `open` on macOS, `xdg-open` on Linux, `start` via cmd on
 * Windows. Detached + unref'd so it never keeps `pmctl run` alive waiting
 * on the browser process, and every failure is swallowed: if nothing opens
 * (headless/SSH session, no GUI, missing opener binary), the terminal's
 * full-screen plan view (runView.tsx) is still right there as the fallback
 * — this is a convenience, not the only way to read the plan.
 */
export function openInBrowser(filePath: string): void {
  try {
    const platform = process.platform;
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no opener available — ignore, terminal view is the fallback */
    });
    child.unref();
  } catch {
    // best-effort only
  }
}

export function buildPlanHtml(opts: {
  feature: string;
  clickupRef: string;
  planMarkdown: string;
  log: LogEntry[];
  generatedAt: string;
}): string {
  const { feature, clickupRef, planMarkdown, log, generatedAt } = opts;
  const flowChart = buildFlowChart(log);
  const planBody = mdToHtml(planMarkdown);

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>Plan: ${escapeHtml(feature)}</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <h1>Plan — ${escapeHtml(feature)} (${escapeHtml(clickupRef)})</h1>
    <div class="meta">สร้างเมื่อ ${escapeHtml(generatedAt)} — ไฟล์นี้เป็นสแนปช็อตแบบ static</div>
    <div class="banner">อนุมัติ/ยกเลิก plan นี้ที่หน้าจอ <code>pmctl run</code> ในเทอร์มินัล (y/Enter อนุมัติ, n ยกเลิก) — หน้านี้มีไว้อ่านอย่างเดียว</div>

    <h2>สถานะ pipeline</h2>
    ${flowChart}

    <h2>เนื้อหา plan</h2>
    <div class="plan-body">
      ${planBody}
    </div>
  </div>
</body>
</html>`;
}
