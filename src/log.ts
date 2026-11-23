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

export function readLog(repoRoot: string, feature: string): LogEntry[] {
  const file = featureFile(repoRoot, feature, "log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
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
