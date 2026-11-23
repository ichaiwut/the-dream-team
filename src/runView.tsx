import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import { Meta } from "./worktree.js";
import { readLog, LogEntry } from "./log.js";
import { featureFile } from "./paths.js";
import { buildPmSessionPlan, spawnClaudeProcess, PmPhase } from "./agents.js";

const LOG_POLL_MS = 1000;
const MAX_LINES = 2000;

// Rows the chrome around the panels takes up: title line + its blank
// margin line + each panel's own header line + its top/bottom border.
const HEADER_ROWS = 2;
const PANEL_CHROME_ROWS = 3;
const CHECKLIST_WIDTH_RATIO = 0.22;
const MIN_CHECKLIST_WIDTH = 28;
const MIN_SIDE_PANEL_WIDTH = 30;

// Which sub-agent is "active" right now, derived from the log's most recent
// `<agent>_started` entry (see computeActiveAgent below) — used to decide
// which raw --output-format json transcript (teed to its own session log by
// roles/pm.md) to show in the third panel.
type SubAgent = "dev" | "reviewer" | "tester";

const AGENT_PANEL_TITLE: Record<SubAgent, string> = {
  dev: "DEV SESSION (live)",
  reviewer: "REVIEWER SESSION (live)",
  tester: "TESTER SESSION (live)",
};

const AGENT_LOG_FILE: Record<SubAgent, "devSession" | "reviewerSession" | "testerSession"> = {
  dev: "devSession",
  reviewer: "reviewerSession",
  tester: "testerSession",
};

/**
 * Picks whichever sub-agent most recently started, by scanning the log in
 * order. Naturally follows PM back to "dev" on every iteration, since
 * roles/pm.md logs a fresh "dev_started" each time it loops Dev back in —
 * no special-casing of "iteration" needed here. Returns null before Dev has
 * ever been dispatched (steps 0/1, ClickUp fetch + plan, have no sub-agent
 * transcript to show yet).
 */
function computeActiveAgent(log: LogEntry[]): SubAgent | null {
  let agent: SubAgent | null = null;
  for (const entry of log) {
    if (entry.step === "dev_started") agent = "dev";
    else if (entry.step === "reviewer_started") agent = "reviewer";
    else if (entry.step === "tester_started") agent = "tester";
  }
  return agent;
}

/** Each sub-agent's session log is overwritten (`tee`, not `tee -a`) on every
 * fresh invocation by roles/pm.md, so reading it whole on every poll always
 * reflects that agent's current/latest round rather than every past one. */
function readSubAgentLines(repoRoot: string, feature: string, agent: SubAgent | null): string[] {
  if (!agent) return [];
  const file = featureFile(repoRoot, feature, AGENT_LOG_FILE[agent]);
  if (!fs.existsSync(file)) return [];
  try {
    return splitLines(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Which PM invocation `pmctl run` should start with, given whatever's
 * already on disk for this feature — so re-running `pmctl run` on a feature
 * whose plan is already written (the PO edited plan.md by hand, or just
 * came back after `pmctl run` exited) resumes sensibly instead of either
 * redoing the ClickUp fetch/plan from scratch or silently re-asking for
 * approval of work that's already past it:
 *   - no plan.md yet -> "initial" (normal start for a brand-new feature)
 *   - plan.md exists, Dev never dispatched -> "awaitingApprovalResume"
 *     (don't spawn anything yet; show the approval prompt immediately)
 *   - plan.md exists and Dev was already dispatched at some point -> treat
 *     the plan as already (implicitly) approved and continue from Dev
 */
type ResumeDecision = PmPhase | "awaitingApprovalResume";

function determineResumePhase(repoRoot: string, feature: string): ResumeDecision {
  const planPath = featureFile(repoRoot, feature, "plan");
  if (!fs.existsSync(planPath)) return "initial";
  const log = readLog(repoRoot, feature);
  return log.some((e) => e.step === "dev_started") ? "continueAfterApproval" : "awaitingApprovalResume";
}

function readPlanPreview(repoRoot: string, feature: string): string {
  const planPath = featureFile(repoRoot, feature, "plan");
  try {
    return fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8") : "(ไม่พบ plan.md)";
  } catch {
    return "(อ่าน plan.md ไม่สำเร็จ)";
  }
}

// The canonical PO->PM->Dev->Tester pipeline, in order, as roles/pm.md
// instructs PM to log it (log.ts' step field). Used to render a todo-style
// checklist instead of a raw dump of log lines.
const PIPELINE: { id: string; label: string }[] = [
  { id: "spec_fetched", label: "ดึง spec จาก ClickUp" },
  { id: "plan_written", label: "วางแผน (plan.md)" },
  { id: "plan_awaiting_approval", label: "รอ PO อนุมัติ plan" },
  { id: "dev_started", label: "สั่ง Dev" },
  { id: "dev_done", label: "Dev ทำงานเสร็จ" },
  { id: "reviewer_started", label: "สั่ง Reviewer ตรวจโค้ด" },
  { id: "reviewer_done", label: "Reviewer ผ่านแล้ว" },
  { id: "tester_started", label: "สั่ง Tester (e2e)" },
  { id: "tester_done", label: "Tester ตรวจสอบเสร็จ" },
  { id: "final_done", label: "จบงาน" },
];

interface ChecklistItem {
  id: string;
  label: string;
  status: "done" | "current" | "pending";
}

interface Checklist {
  items: ChecklistItem[];
  iterationCount: number;
  needsAttention: boolean;
}

/**
 * Turns the append-only log into a todo-style checklist against the fixed
 * pipeline above. Since Dev/Tester can be looped back into on a test
 * failure ("iteration" in roles/pm.md's step 4), the pointer rolls back to
 * just after the plan was approved on every iteration, so mid-loop the
 * checklist correctly shows Dev/Tester as pending again rather than staying
 * "done" from an earlier failed round.
 */
function computeChecklist(log: LogEntry[]): Checklist {
  let pointer = -1;
  let iterationCount = 0;
  let needsAttention = false;

  for (const entry of log) {
    if (entry.step === "iteration") {
      iterationCount++;
      pointer = Math.min(pointer, 2); // back to right after plan_awaiting_approval
      continue;
    }
    if (entry.step === "needs_po_attention") {
      needsAttention = true;
      continue;
    }
    const idx = PIPELINE.findIndex((p) => p.id === entry.step);
    if (idx !== -1 && idx > pointer) pointer = idx;
  }

  // Before PM has appended its very first log line, pointer stays -1 — but
  // PM is already alive and working toward step 0 (fetching the ClickUp
  // spec), possibly for a while (a slow ClickUp call, or just a lot of
  // reasoning). Without this, every item shows pending with no "current"
  // marker at all, which reads as "nothing is happening" even while PM's
  // own panel is visibly streaming output. Treating -1 like 0 here (for the
  // *current* marker only — not for "done") fixes that without claiming
  // step 0 is finished before it's logged as such.
  const currentPointer = Math.max(pointer, 0);
  const items: ChecklistItem[] = PIPELINE.map((p, i) => ({
    ...p,
    status:
      i < pointer
        ? "done"
        : i === currentPointer
          ? (i === PIPELINE.length - 1 ? "done" : "current")
          : "pending",
  }));

  return { items, iterationCount, needsAttention };
}

function checklistColor(status: ChecklistItem["status"]): string | undefined {
  if (status === "done") return "green";
  if (status === "current") return "yellow";
  return undefined;
}

function checklistMark(status: ChecklistItem["status"]): string {
  if (status === "done") return "☑";
  if (status === "current") return "▶";
  return "☐";
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Border (1 col each side) + paddingX={1} (1 col each side) eaten by every panel.
const PANEL_INNER_PADDING = 4;

/**
 * Soft-wraps a single raw line to `width` columns, breaking on spaces where
 * possible and hard-breaking any single run longer than `width` (Thai text
 * has no spaces to break on, so long Thai runs — and URLs — always hit this
 * path). Without this, Ink's own `wrap="truncate-end"` just chops a line
 * dead at the panel edge, so most of every long line (easily most of a
 * markdown paragraph) never gets seen at all.
 */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0 || line.length <= width) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  let cur = "";
  for (let word of words) {
    while (word.length > width) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    const candidate = cur.length === 0 ? word : `${cur} ${word}`;
    if (candidate.length > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  out.push(cur);
  return out;
}

function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((l) => wrapLine(l, width));
}

interface PlanLine {
  text: string;
  heading: boolean;
}

/**
 * Turns raw plan.md markdown into lines fit for the full-width approval
 * screen: `#`-headings get stripped of their hashes and rendered bold/cyan so
 * the plan's own section structure (the "summary") is visible at a glance
 * instead of reading as an undifferentiated wall of text, and every line is
 * wrapped against the *real* full terminal width rather than a cramped
 * one-third-of-screen side panel.
 */
function renderPlanLines(raw: string, width: number): PlanLine[] {
  const out: PlanLine[] = [];
  for (const rawLine of splitLines(raw)) {
    const trimmed = rawLine.trimStart();
    const isHeading = /^#{1,6}\s/.test(trimmed);
    const content = isHeading ? trimmed.replace(/^#{1,6}\s*/, "") : rawLine;
    for (const w of wrapLine(content, width)) out.push({ text: w, heading: isHeading });
  }
  return out;
}

/** Tracks the real terminal size and re-renders on resize, so the UI always fills the screen. */
function useTerminalSize() {
  const [size, setSize] = useState({
    columns: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  });

  useEffect(() => {
    const onResize = () =>
      setSize({ columns: process.stdout.columns || 100, rows: process.stdout.rows || 30 });
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  return size;
}

function App({
  repoRoot,
  meta,
  permissionMode,
  clickupRef,
  onDone,
}: {
  repoRoot: string;
  meta: Meta;
  permissionMode: string;
  clickupRef: string;
  onDone: (code: number) => void;
}) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [lines, setLines] = useState<string[]>([]);
  const [log, setLog] = useState<LogEntry[]>(() => readLog(repoRoot, meta.feature));
  const [subAgent, setSubAgent] = useState<SubAgent | null>(() => computeActiveAgent(readLog(repoRoot, meta.feature)));
  const [subLines, setSubLines] = useState<string[]>([]);
  const [done, setDone] = useState<{ code: number; rejected?: boolean } | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [planPreview, setPlanPreview] = useState("");
  // Starts at the top of the plan (not the tail) every time a fresh plan is
  // shown, since the top is where the summary/overview lives.
  const [planScroll, setPlanScroll] = useState(0);
  const childRef = useRef<ChildProcessByStdio<null, Readable, Readable> | null>(null);
  const tailRef = useRef(""); // carries a partial last line between chunks

  /**
   * Spawns one PM invocation for the given phase and wires up its output —
   * shared between the initial mount and the second invocation fired after
   * the PO approves the plan (see the "y" key handling in useInput below).
   * Only "initial" can end in the approval prompt instead of "done": that's
   * the only phase where PM is instructed to stop short of Dev.
   */
  function startPhase(phase: PmPhase) {
    const plan = buildPmSessionPlan(repoRoot, meta, permissionMode, clickupRef, phase);
    plan.logFile.write(plan.notice);

    const child = spawnClaudeProcess(plan.args, plan.cwd);
    childRef.current = child;
    tailRef.current = "";

    const onChunk = (chunk: Buffer) => {
      plan.logFile.write(chunk);
      const text = tailRef.current + chunk.toString("utf8");
      const parts = splitLines(text);
      tailRef.current = parts.pop() ?? "";
      if (parts.length === 0) return;
      setLines((prev) => {
        const next = prev.concat(parts);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    child.on("close", (code) => {
      plan.logFile.end();
      if (tailRef.current) {
        setLines((prev) => prev.concat(tailRef.current));
        tailRef.current = "";
      }
      const freshLog = readLog(repoRoot, meta.feature);
      const reachedApprovalPoint =
        phase === "initial" &&
        (code ?? 0) === 0 &&
        freshLog.some((e) => e.step === "plan_awaiting_approval") &&
        !freshLog.some((e) => e.step === "dev_started");
      if (reachedApprovalPoint) {
        setPlanPreview(readPlanPreview(repoRoot, meta.feature));
        setPlanScroll(0);
        setAwaitingApproval(true);
      } else {
        setDone({ code: code ?? 0 });
      }
    });
  }

  useEffect(() => {
    const resume = determineResumePhase(repoRoot, meta.feature);
    if (resume === "awaitingApprovalResume") {
      setPlanPreview(readPlanPreview(repoRoot, meta.feature));
      setPlanScroll(0);
      setAwaitingApproval(true);
    } else {
      startPhase(resume);
    }

    return () => {
      if (childRef.current && !childRef.current.killed) {
        childRef.current.kill();
      }
    };
    // Spawn exactly once per mount — meta/permissionMode/clickupRef don't change mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const freshLog = readLog(repoRoot, meta.feature);
      setLog(freshLog);
      const agent = computeActiveAgent(freshLog);
      setSubAgent(agent);
      setSubLines(readSubAgentLines(repoRoot, meta.feature, agent));
    }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [repoRoot, meta.feature]);

  // Full-screen plan view: the whole terminal width/height (minus the header
  // line and this panel's own border+instructions+scroll-indicator rows),
  // not the cramped one-third-of-screen side panel the approval prompt used
  // to share with the PM transcript. That old layout only ever showed the
  // *tail* of plan.md — which, for anything longer than a screen, hid the
  // summary at the top entirely. This view starts at the top and scrolls.
  const planWidth = Math.max(40, columns - 2);
  const planPanelHeight = Math.max(5, rows - HEADER_ROWS);
  const planVisibleRows = Math.max(1, planPanelHeight - PANEL_CHROME_ROWS - 2);
  const planLines = awaitingApproval ? renderPlanLines(planPreview, planWidth - PANEL_INNER_PADDING) : [];
  const planMaxScroll = Math.max(0, planLines.length - planVisibleRows);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      childRef.current?.kill();
      onDone(130);
      exit();
      return;
    }
    if (awaitingApproval) {
      if (input === "y" || key.return) {
        setAwaitingApproval(false);
        setLines([]); // fresh transcript for the post-approval PM invocation
        startPhase("continueAfterApproval");
      } else if (input === "n") {
        setAwaitingApproval(false);
        setDone({ code: 2, rejected: true });
      } else if (key.downArrow || input === "j") {
        setPlanScroll((s) => Math.min(planMaxScroll, s + 1));
      } else if (key.upArrow || input === "k") {
        setPlanScroll((s) => Math.max(0, s - 1));
      } else if (input === "f" || input === " ") {
        setPlanScroll((s) => Math.min(planMaxScroll, s + planVisibleRows));
      } else if (input === "b") {
        setPlanScroll((s) => Math.max(0, s - planVisibleRows));
      } else if (input === "g") {
        setPlanScroll(0);
      } else if (input === "G") {
        setPlanScroll(planMaxScroll);
      }
      return;
    }
    if (done && (input === "q" || key.return)) {
      onDone(done.code);
      exit();
    }
  });

  if (awaitingApproval) {
    const visiblePlan = planLines.slice(planScroll, planScroll + planVisibleRows);
    const atTop = planScroll === 0;
    const atBottom = planScroll >= planMaxScroll;
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box>
          <Text bold>pmctl run — {meta.feature}</Text>
          <Text dimColor> (branch={meta.branch}) — plan.md รออนุมัติ</Text>
        </Box>
        <Box
          marginTop={1}
          height={planPanelHeight}
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
        >
          <Text bold color="yellow">
            กด y หรือ Enter เพื่ออนุมัติและสั่ง Dev ต่อ · n ยกเลิก (แก้ plan.md เองได้แล้วรัน pmctl run ใหม่) · ↑/↓
            หรือ j/k เลื่อน · space/f หน้าถัดไป · b หน้าก่อนหน้า · g/G บนสุด/ล่างสุด
          </Text>
          <Text dimColor>
            บรรทัด {planLines.length === 0 ? 0 : planScroll + 1}-{Math.min(planLines.length, planScroll + planVisibleRows)} จาก{" "}
            {planLines.length}
            {atTop ? "" : " ↑มีต่อด้านบน"}
            {atBottom ? "" : " ↓มีต่อด้านล่าง"}
          </Text>
          {visiblePlan.map((l, i) => (
            <Text key={i} bold={l.heading} color={l.heading ? "cyan" : undefined} wrap="truncate-end">
              {l.text || " "}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  // Fill the real terminal: compute panel widths/heights from the current
  // columns/rows instead of hardcoding them, and recompute whenever the
  // terminal is resized (useTerminalSize above).
  const checklistWidth = Math.max(MIN_CHECKLIST_WIDTH, Math.floor(columns * CHECKLIST_WIDTH_RATIO));
  // Three side-by-side panels need real width to stay readable; below this,
  // an 80-col terminal (a common default) would overflow. Below the
  // threshold, fall back to the original two-panel layout — checklist + PM
  // session only — rather than cramming a third panel no one can read.
  const showSubPanel = columns >= 100;
  let pmWidth: number;
  let subWidth: number;
  if (showSubPanel) {
    const remainingWidth = columns - checklistWidth - 4; // 4 = two 1-col gaps between three panels
    pmWidth = Math.max(MIN_SIDE_PANEL_WIDTH, Math.ceil(remainingWidth / 2));
    subWidth = Math.max(MIN_SIDE_PANEL_WIDTH, remainingWidth - pmWidth);
  } else {
    pmWidth = Math.max(40, columns - checklistWidth - 3); // 3 = gap + borders between two panels
    subWidth = 0;
  }
  // Narrow-terminal fallback prints one extra hint line below the panels,
  // so reserve a row for it or the layout would overflow the real terminal.
  const panelHeight = Math.max(5, rows - HEADER_ROWS - (showSubPanel ? 0 : 1));
  const visibleRows = Math.max(1, panelHeight - PANEL_CHROME_ROWS - (done ? 1 : 0));

  const checklist = computeChecklist(log);
  const subPanelTitle = subAgent ? AGENT_PANEL_TITLE[subAgent] : "SUB-AGENT (ยังไม่เริ่ม)";
  const footerHint = done ? ", q/Enter ออก" : "";

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text bold>pmctl run — {meta.feature}</Text>
        <Text dimColor>
          {" "}
          (branch={meta.branch}) — Ctrl+C ยกเลิก{footerHint}
        </Text>
      </Box>
      <Box marginTop={1} height={panelHeight}>
        <Box flexDirection="column" width={checklistWidth} height={panelHeight} borderStyle="single" paddingX={1}>
          <Text bold dimColor>
            TODO (PM → Dev → Tester)
          </Text>
          {checklist.items.map((item) => {
            const stuck = item.status === "current" && checklist.needsAttention;
            return (
              <Text key={item.id} color={stuck ? "red" : checklistColor(item.status)} bold={item.status === "current"}>
                {stuck ? "⚠" : checklistMark(item.status)} {item.label}
              </Text>
            );
          })}
          {checklist.iterationCount > 0 && (
            <Text color="yellow">↻ วนแก้แล้ว {checklist.iterationCount} รอบ</Text>
          )}
          {checklist.needsAttention && (
            <Text bold color="red">
              ⚠ ต้องการให้ PO ตัดสินใจ — ดูคำตอบสุดท้ายของ PM
            </Text>
          )}
        </Box>

        <Box
          flexDirection="column"
          width={pmWidth}
          height={panelHeight}
          borderStyle="single"
          paddingX={1}
          marginLeft={1}
        >
          <Text bold dimColor>
            PM SESSION (live)
          </Text>
          {lines.length === 0 && !done && <Text dimColor>(กำลังเริ่ม...)</Text>}
          {wrapLines(lines, pmWidth - PANEL_INNER_PADDING)
            .slice(-visibleRows)
            .map((l, i) => (
              <Text key={i} wrap="truncate-end">
                {l}
              </Text>
            ))}
          {done && !done.rejected && (
            <Text bold color={done.code === 0 ? "green" : "red"}>
              -- จบแล้ว (exit code {done.code}) --
            </Text>
          )}
          {done && done.rejected && (
            <Text bold color="red">
              -- ยกเลิกแล้ว แก้ plan.md เองแล้วรัน pmctl run ใหม่เพื่อขอ approve อีกรอบ --
            </Text>
          )}
        </Box>

        {showSubPanel && (
          <Box
            flexDirection="column"
            width={subWidth}
            height={panelHeight}
            borderStyle="single"
            paddingX={1}
            marginLeft={1}
          >
            <Text bold dimColor>
              {subPanelTitle}
            </Text>
            {!subAgent && <Text dimColor>(PM ยังไม่ได้สั่ง Dev/Reviewer/Tester)</Text>}
            {subAgent && subLines.length === 0 && <Text dimColor>(รอผลลัพธ์...)</Text>}
            {wrapLines(subLines, subWidth - PANEL_INNER_PADDING)
              .slice(-visibleRows)
              .map((l, i) => (
                <Text key={i} wrap="truncate-end">
                  {l}
                </Text>
              ))}
          </Box>
        )}
      </Box>
      {!showSubPanel && (
        <Text dimColor>ขยายเทอร์มินัลให้กว้าง ≥100 คอลัมน์ เพื่อดูพาเนล Dev/Reviewer/Tester แยก</Text>
      )}
    </Box>
  );
}

/**
 * Interactive, single-screen alternative to running `pmctl run` and
 * `pmctl watch` in two separate terminals: renders a PM→Dev→Tester todo
 * checklist next to the PM session's live output, in one Ink UI that fills
 * the real terminal and follows it on resize. Falls back to spawnPmSession
 * (plain stdout streaming) when stdin/stdout aren't a real TTY — see
 * src/cli.ts.
 */
export function runPmSessionWithTui(
  repoRoot: string,
  meta: Meta,
  permissionMode: string,
  clickupRef: string
): Promise<number> {
  return new Promise((resolve) => {
    render(
      <App
        repoRoot={repoRoot}
        meta={meta}
        permissionMode={permissionMode}
        clickupRef={clickupRef}
        onDone={resolve}
      />
    );
  });
}
