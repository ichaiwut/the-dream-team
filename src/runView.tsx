import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import { Meta } from "./worktree.js";
import { readLog, LogEntry } from "./log.js";
import { featureFile } from "./paths.js";
import { buildPmSessionPlan, spawnClaudeProcess } from "./agents.js";

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

// The canonical PO->PM->Dev->Tester pipeline, in order, as roles/pm.md
// instructs PM to log it (log.ts' step field). Used to render a todo-style
// checklist instead of a raw dump of log lines.
const PIPELINE: { id: string; label: string }[] = [
  { id: "spec_fetched", label: "ดึง spec จาก ClickUp" },
  { id: "plan_written", label: "วางแผน (plan.md)" },
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
 * just after plan_written on every iteration, so mid-loop the checklist
 * correctly shows Dev/Tester as pending again rather than staying "done"
 * from an earlier failed round.
 */
function computeChecklist(log: LogEntry[]): Checklist {
  let pointer = -1;
  let iterationCount = 0;
  let needsAttention = false;

  for (const entry of log) {
    if (entry.step === "iteration") {
      iterationCount++;
      pointer = Math.min(pointer, 1); // back to right after plan_written
      continue;
    }
    if (entry.step === "needs_po_attention") {
      needsAttention = true;
      continue;
    }
    const idx = PIPELINE.findIndex((p) => p.id === entry.step);
    if (idx !== -1 && idx > pointer) pointer = idx;
  }

  const items: ChecklistItem[] = PIPELINE.map((p, i) => ({
    ...p,
    status: i < pointer ? "done" : i === pointer ? (i === PIPELINE.length - 1 ? "done" : "current") : "pending",
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
  const [done, setDone] = useState<{ code: number } | null>(null);
  const childRef = useRef<ChildProcessByStdio<null, Readable, Readable> | null>(null);
  const tailRef = useRef(""); // carries a partial last line between chunks

  useEffect(() => {
    const plan = buildPmSessionPlan(repoRoot, meta, permissionMode, clickupRef);
    plan.logFile.write(plan.notice);

    const child = spawnClaudeProcess(plan.args, plan.cwd);
    childRef.current = child;

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
      setDone({ code: code ?? 0 });
    });

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

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      childRef.current?.kill();
      onDone(130);
      exit();
      return;
    }
    if (done && (input === "q" || key.return)) {
      onDone(done.code);
      exit();
    }
  });

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

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text bold>pmctl run — {meta.feature}</Text>
        <Text dimColor>
          {" "}
          (branch={meta.branch}) — Ctrl+C ยกเลิก{done ? ", q/Enter ออก" : ""}
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
          {done && (
            <Text bold color={done.code === 0 ? "green" : "red"}>
              -- จบแล้ว (exit code {done.code}) --
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
