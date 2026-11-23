import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { Meta } from "./worktree.js";
import { readLog, LogEntry } from "./log.js";
import { buildPmSessionPlan, spawnClaudeProcess } from "./agents.js";

const LOG_POLL_MS = 1000;
const MAX_LINES = 2000;

// Rows the chrome around the two panels takes up: title line + its blank
// margin line + each panel's own header line + its top/bottom border.
const HEADER_ROWS = 2;
const PANEL_CHROME_ROWS = 3;
const CHECKLIST_WIDTH_RATIO = 0.28;
const MIN_CHECKLIST_WIDTH = 30;

// The canonical PO->PM->Dev->Tester pipeline, in order, as roles/pm.md
// instructs PM to log it (log.ts' step field). Used to render a todo-style
// checklist instead of a raw dump of log lines.
const PIPELINE: { id: string; label: string }[] = [
  { id: "spec_fetched", label: "ดึง spec จาก ClickUp" },
  { id: "plan_written", label: "วางแผน (plan.md)" },
  { id: "dev_started", label: "สั่ง Dev" },
  { id: "dev_done", label: "Dev ทำงานเสร็จ" },
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
    const timer = setInterval(() => setLog(readLog(repoRoot, meta.feature)), LOG_POLL_MS);
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
  const pmWidth = Math.max(40, columns - checklistWidth - 3); // 3 = gap + borders between panels
  const panelHeight = Math.max(5, rows - HEADER_ROWS);
  const visibleRows = Math.max(1, panelHeight - PANEL_CHROME_ROWS - (done ? 1 : 0));

  const checklist = computeChecklist(log);

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
          {checklist.items.map((item) => (
            <Text key={item.id} color={checklistColor(item.status)} bold={item.status === "current"}>
              {checklistMark(item.status)} {item.label}
            </Text>
          ))}
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
          {lines.slice(-visibleRows).map((l, i) => (
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
      </Box>
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
