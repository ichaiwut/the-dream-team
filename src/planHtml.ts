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

// PM sometimes writes a "## คำถามถึง PO" (or "Questions to/for PO") section
// into plan.md when it needs a product decision only a human can make. This
// file is a static, read-only snapshot (no form, no inputs), so detecting
// that section lets the generated page point PO back at the one place that
// *can* take an answer: the "a" key on the terminal approval screen (see
// src/runView.tsx). Deliberately loose — it only has to catch the common
// phrasings PM actually uses, not parse arbitrary markdown.
// No \b around "คำถาม": \b only fires at a \w/non-\w boundary, and JS regex
// treats Thai characters as non-\w, so a boundary never appears between a
// space and Thai text — \b"คำถาม"\b would silently never match.
const OPEN_QUESTIONS_HEADING_RE = /^#{1,6}.*(คำถาม|\bquestions?\b)/im;

export function hasOpenQuestions(markdown: string): boolean {
  return OPEN_QUESTIONS_HEADING_RE.test(markdown);
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
  let openList: "ul" | "ol" | null = null;
  const closeList = () => {
    if (openList) {
      html += `</${openList}>\n`;
      openList = null;
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

    // Fenced code block (```lang ... ```). plan.md's own "## Flow" section is
    // exactly this — PM writes a real ```mermaid flowchart ...``` block —
    // and without handling the fence explicitly it fell into the plain
    // paragraph branch below, which joins every line with a single space and
    // runs it through inline-bold/code — turning a diagram source into one
    // unreadable run-on blob. A ```mermaid block renders as an actual
    // diagram (mermaid.js, loaded in the page head); any other language (or
    // none) renders as a plain preformatted block, line breaks intact.
    const fence = /^```\s*([\w-]*)\s*$/.exec(trimmed);
    if (fence) {
      closeList();
      const lang = fence[1].toLowerCase();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "```") {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip the closing ``` (or run off the end if plan.md is missing one)
      const code = escapeHtml(codeLines.join("\n"));
      if (lang === "mermaid") {
        html += `<pre class="mermaid">${code}</pre>\n`;
      } else {
        html += `<pre class="code-block"><code>${code}</code></pre>\n`;
      }
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
      if (openList !== "ul") {
        closeList();
        html += "<ul>\n";
        openList = "ul";
      }
      html += `<li>${inlineMd(escapeHtml(trimmed.replace(/^[-*]\s+/, "")))}</li>\n`;
      i++;
      continue;
    }

    // Ordered list ("1. ", "2. ", ...) — plan.md's own "ขั้นตอนการทำงาน"
    // steps are written this way. Without handling it, each numbered line
    // fell into the plain-paragraph branch below and got joined with every
    // following line into one run-on sentence ("1. Dev ... 2. Reviewer ...
    // 3. Tester ..." all on one line) instead of staying a numbered list.
    if (/^\d+\.\s+/.test(trimmed)) {
      if (openList !== "ol") {
        closeList();
        html += "<ol>\n";
        openList = "ol";
      }
      html += `<li>${inlineMd(escapeHtml(trimmed.replace(/^\d+\.\s+/, "")))}</li>\n`;
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
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("|") &&
      !/^```/.test(lines[i].trim())
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
  .banner.qa-banner {
    background: #3a1414; border-color: #e65a5a; color: #ff9b9b; margin-top: -16px;
  }
  .banner code { background: rgba(255,255,255,0.12); }
  h2 { font-size: 1.15rem; margin-top: 28px; color: #7cc7ff; }
  h3 { font-size: 1.0rem; margin-top: 20px; color: #7cc7ff; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 0.92rem; }
  th, td { border: 1px solid #333a45; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #1a1f29; }
  code { background: #1a1f29; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  ul, ol { margin: 8px 0; padding-left: 22px; }
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
  pre.code-block {
    background: #1a1f29; border: 1px solid #333a45; border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; font-size: 0.88rem;
  }
  pre.mermaid {
    background: #fff; border-radius: 8px; padding: 12px; overflow-x: auto;
    /* Light background: mermaid's default theme renders dark text/lines that
       disappear against this page's otherwise-dark background. If mermaid.js
       never loads (no internet), this still just shows the raw diagram
       source as plain text — readable, if not rendered. */
  }
`;

// Loaded from a CDN at view time (the user opens this file in their own
// browser, which needs internet for this one script either way) — not
// bundled, so pmctl itself stays dependency-free. If it fails to load (no
// internet, CDN blocked), every ```mermaid block just stays visible as plain
// text in its <pre> — degraded, not broken.
const MERMAID_SCRIPT = `
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: true, theme: "default" });
  }
</script>`;

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
  const qaBanner = hasOpenQuestions(planMarkdown)
    ? `<div class="banner qa-banner">⚠ PM มีคำถามถึง PO ใน plan นี้ (ดูหัวข้อ "คำถามถึง PO" ด้านล่าง) — ` +
      `หน้านี้อ่านอย่างเดียว ตอบตรงนี้ไม่ได้ กลับไปที่เทอร์มินัลที่รัน <code>pmctl run</code> แล้วกด <code>a</code> ` +
      `เพื่อพิมพ์คำตอบก่อนกด approve</div>`
    : "";

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>Plan: ${escapeHtml(feature)}</title>
<style>${STYLE}</style>
${MERMAID_SCRIPT}
</head>
<body>
  <div class="wrap">
    <h1>Plan — ${escapeHtml(feature)} (${escapeHtml(clickupRef)})</h1>
    <div class="meta">สร้างเมื่อ ${escapeHtml(generatedAt)} — ไฟล์นี้เป็นสแนปช็อตแบบ static</div>
    <div class="banner">อนุมัติ/ยกเลิก plan นี้ที่หน้าจอ <code>pmctl run</code> ในเทอร์มินัล (y/Enter อนุมัติ, n ยกเลิก, a พิมพ์คำตอบก่อนอนุมัติ) — หน้านี้มีไว้อ่านอย่างเดียว</div>
    ${qaBanner}

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
