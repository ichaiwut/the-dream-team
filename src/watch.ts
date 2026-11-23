import fs from "node:fs";
import path from "node:path";
import { loadMeta } from "./worktree.js";
import { readLog, LogEntry } from "./log.js";
import { stateRoot } from "./paths.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function colorForStep(step: string): string {
  if (step === "final_done" || step === "tester_done") return GREEN;
  if (step === "needs_po_attention") return RED;
  if (step === "iteration") return YELLOW;
  return CYAN;
}

function actorBadge(actor: LogEntry["actor"]): string {
  switch (actor) {
    case "pm":
      return "[PM]";
    case "dev":
      return "[DEV]";
    case "tester":
      return "[TESTER]";
    default:
      return "[SYS]";
  }
}

function listFeatures(repoRoot: string): string[] {
  const root = stateRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, "meta.json")));
}

function render(repoRoot: string): string {
  const features = listFeatures(repoRoot);
  if (features.length === 0) {
    return "ยังไม่มี feature ไหนเริ่มทำงานเลย — รัน `pmctl run <feature> --clickup <id>` ก่อน\n";
  }

  const lines: string[] = [];
  lines.push(`${BOLD}pmctl watch${RESET} — ${new Date().toLocaleTimeString("th-TH")}  (Ctrl+C เพื่อออก)`);
  lines.push(DIM + "─".repeat(72) + RESET);

  for (const feature of features) {
    const meta = loadMeta(repoRoot, feature);
    const log = readLog(repoRoot, feature);
    const last = log[log.length - 1];

    lines.push(`${BOLD}${feature}${RESET}  ${DIM}branch=${meta.branch} port=${meta.port}${RESET}`);

    if (!last) {
      lines.push(`  ${DIM}(ยังไม่มี log)${RESET}`);
    } else {
      const color = colorForStep(last.step);
      lines.push(`  ${color}${actorBadge(last.actor)} ${last.step}${RESET} — ${last.reason}`);
    }

    // show last 2 entries before the latest, for a little trail of context
    const trail = log.slice(-3, -1);
    for (const entry of trail) {
      lines.push(`  ${DIM}${actorBadge(entry.actor)} ${entry.step}${RESET}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function watchFeatures(repoRoot: string, intervalMs = 1500): void {
  // Clear-screen + home-cursor escape, redraw on an interval. No external
  // TUI library on purpose — this polls the same log.ndjson files `pmctl
  // log`/`status` read, it just keeps redrawing them.
  const draw = () => {
    process.stdout.write("\x1Bc"); // reset terminal
    process.stdout.write(render(repoRoot));
  };

  draw();
  const timer = setInterval(draw, intervalMs);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.stdout.write("\n");
    process.exit(0);
  });
}
