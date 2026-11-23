import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { Meta } from "./worktree.js";
import { readLog, LogEntry } from "./log.js";
import { buildPmSessionPlan, spawnClaudeProcess } from "./agents.js";
import { stepColor, actorBadge } from "./tui.js";

const LOG_POLL_MS = 1000;
const MAX_LINES = 2000;

// Rows the chrome around the two panels takes up: title line + its blank
// margin line + each panel's own header line + its top/bottom border.
const HEADER_ROWS = 2;
const PANEL_CHROME_ROWS = 3;
const STATUS_WIDTH_RATIO = 0.3;
const MIN_STATUS_WIDTH = 28;

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
  const statusWidth = Math.max(MIN_STATUS_WIDTH, Math.floor(columns * STATUS_WIDTH_RATIO));
  const pmWidth = Math.max(40, columns - statusWidth - 3); // 3 = gap + borders between panels
  const panelHeight = Math.max(5, rows - HEADER_ROWS);
  const visibleRows = Math.max(1, panelHeight - PANEL_CHROME_ROWS - (done ? 1 : 0));

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
        <Box flexDirection="column" width={pmWidth} height={panelHeight} borderStyle="single" paddingX={1}>
          <Text bold dimColor>
            PM SESSION (live) — agent ที่กำลังทำงานตอนนี้ดูได้ที่ STATUS ด้านขวา
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

        <Box
          flexDirection="column"
          width={statusWidth}
          height={panelHeight}
          borderStyle="single"
          paddingX={1}
          marginLeft={1}
        >
          <Text bold dimColor>
            STATUS (PM/Dev/Tester)
          </Text>
          {log.length === 0 && <Text dimColor>(ยังไม่มี log)</Text>}
          {log.slice(-Math.max(1, panelHeight - PANEL_CHROME_ROWS)).map((entry, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={stepColor(entry.step)}>
                [{actorBadge(entry.actor)}] {entry.step}
              </Text>
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Interactive, single-screen alternative to running `pmctl run` and
 * `pmctl watch` in two separate terminals: renders the PM session's live
 * output next to this feature's step log, in one Ink UI that fills the
 * real terminal and follows it on resize. Falls back to spawnPmSession
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
