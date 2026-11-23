import fs from "node:fs";
import { featureFile } from "./paths.js";

export type LogActor = "pm" | "dev" | "tester" | "system";

export interface LogEntry {
  ts: string;
  actor: LogActor;
  step: string;
  reason: string;
  result?: string;
}

/**
 * Append-only event log, one JSON object per line (ndjson).
 * This is the local, project-owned record — it is never written to ClickUp.
 * ClickUp stays PO-write / PM-read-only; this file is PM-write / PO-read-only.
 */
export function appendLog(repoRoot: string, feature: string, entry: Omit<LogEntry, "ts">): void {
  const file = featureFile(repoRoot, feature, "log");
  const full: LogEntry = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(file, JSON.stringify(full) + "\n", "utf8");
}

/**
 * Reads the log, keeping the lines that parse and counting the ones that
 * don't.
 *
 * This file is written by an LLM running `echo '{...}' >>` in bash, with
 * free-text Thai `reason` fields several sentences long — so a line that
 * isn't valid JSON is a matter of when, not if: a stray raw newline inside
 * the string, a quote that didn't get escaped, two appends interleaving, a
 * write torn by a kill. The TUI parses this file once a second from inside
 * a timer, where an exception is unhandled and takes the whole run down
 * with it. A real run died exactly that way on a `reviewer_done` line with
 * a control character in it, losing a session whose work was all safely on
 * disk.
 *
 * So one malformed line costs that line, nothing more. The count comes back
 * with the entries rather than being swallowed, so the UI can say the log
 * has damage in it instead of quietly showing a short history as if it were
 * complete.
 */
export function readLogSafe(repoRoot: string, feature: string): { entries: LogEntry[]; skipped: number } {
  const file = featureFile(repoRoot, feature, "log");
  if (!fs.existsSync(file)) return { entries: [], skipped: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries: LogEntry[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LogEntry;
      // A line can be valid JSON and still not be a log entry (PM echoing
      // something else into the file). The pipeline keys off `step`, so
      // anything without one is not usable as history.
      if (parsed && typeof parsed.step === "string" && typeof parsed.ts === "string") {
        entries.push({ ...parsed, reason: typeof parsed.reason === "string" ? parsed.reason : "" });
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

export function readLog(repoRoot: string, feature: string): LogEntry[] {
  return readLogSafe(repoRoot, feature).entries;
}

export function formatLog(entries: LogEntry[]): string {
  return entries
    .map(
      (e) =>
        `[${e.ts}] (${e.actor}) ${e.step}\n  เหตุผล: ${e.reason}` +
        (e.result ? `\n  ผลลัพธ์: ${e.result}` : "")
    )
    .join("\n\n");
}
