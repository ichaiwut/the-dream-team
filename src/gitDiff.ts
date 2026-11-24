import { execFileSync } from "node:child_process";
import { listPendingChanges } from "./gitCommit.js";

/**
 * The actual diff of what this run changed, for the gate artifacts.
 *
 * Dev describes its own work in prose ("computed isOnWaitingList at lines
 * 1167-1174 returns true when..."), which is a summary of a diff written
 * by the thing being reviewed — hard to read and impossible to check
 * against. The diff is the ground truth, pmctl can produce it without
 * asking anyone, and it's what the PO would look at anyway.
 *
 * Scoped by the same baseline the commit uses, so it shows the run's work
 * and not whatever the PO had dirty beforehand.
 */

/** Keeps one runaway file (a lockfile, a build artifact) from burying the page. */
const MAX_LINES_PER_FILE = 600;
const MAX_TOTAL_LINES = 4000;

export interface FileDiff {
  path: string;
  /** Unified diff body, hunk headers included. */
  lines: string[];
  truncated: boolean;
  isNew: boolean;
  added: number;
  removed: number;
}

export interface RunDiff {
  files: FileDiff[];
  truncated: boolean;
  /** Paths changed during the run that produced no readable text diff. */
  binaryOrUnreadable: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * `git diff` exits 1 when there are differences, which execFileSync treats
 * as a failure — so the output has to be recovered from the error. Any
 * other failure (a path git can't read) yields "" rather than throwing:
 * a missing diff should degrade the page, never break the gate.
 */
function gitDiffOutput(cwd: string, args: string[]): string {
  try {
    return git(cwd, args);
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    if (e.stdout) return e.stdout.toString();
    return "";
  }
}

function isTracked(cwd: string, file: string): boolean {
  try {
    git(cwd, ["ls-files", "--error-unmatch", "--", file]);
    return true;
  } catch {
    return false;
  }
}

function countChanges(lines: string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
}

export function collectRunDiff(worktreePath: string, repoRoot: string, feature: string): RunDiff {
  const { files } = listPendingChanges(worktreePath, repoRoot, feature);
  const out: FileDiff[] = [];
  const binaryOrUnreadable: string[] = [];
  let total = 0;
  let truncated = false;

  for (const file of files) {
    if (total >= MAX_TOTAL_LINES) {
      truncated = true;
      break;
    }
    const tracked = isTracked(worktreePath, file);
    // HEAD rather than the index, so staged and unstaged work both show —
    // the PO wants what changed, not what happens to be staged.
    const raw = tracked
      ? gitDiffOutput(worktreePath, ["diff", "HEAD", "--", file])
      : gitDiffOutput(worktreePath, ["diff", "--no-index", "--", "/dev/null", file]);

    const body = raw
      .split("\n")
      // The "diff --git"/index/mode preamble is noise once the filename is
      // already a heading on the page; ---/+++ likewise.
      .filter((l) => l !== "" || true)
      .filter(
        (l) =>
          !l.startsWith("diff --git ") &&
          !l.startsWith("index ") &&
          !l.startsWith("new file mode") &&
          !l.startsWith("deleted file mode") &&
          !l.startsWith("old mode") &&
          !l.startsWith("new mode") &&
          !l.startsWith("--- ") &&
          !l.startsWith("+++ ")
      )
      .filter((l, i, arr) => !(l === "" && i === arr.length - 1));

    if (body.length === 0 || body.every((l) => l.trim() === "")) {
      binaryOrUnreadable.push(file);
      continue;
    }
    if (body.some((l) => l.startsWith("Binary files "))) {
      binaryOrUnreadable.push(file);
      continue;
    }

    const room = Math.min(MAX_LINES_PER_FILE, MAX_TOTAL_LINES - total);
    const kept = body.slice(0, room);
    const wasTruncated = kept.length < body.length;
    if (wasTruncated) truncated = true;
    total += kept.length;
    const { added, removed } = countChanges(body);
    out.push({ path: file, lines: kept, truncated: wasTruncated, isNew: !tracked, added, removed });
  }

  return { files: out, truncated, binaryOrUnreadable };
}
