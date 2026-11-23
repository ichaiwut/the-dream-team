import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureFeatureDir, featureFile, stateRoot } from "./paths.js";

export interface Meta {
  feature: string;
  branch: string;
  worktreePath: string;
  port: number;
  clickupTaskId?: string;
  createdAt: string;
}

const BASE_PORT = 3001;

function usedPorts(repoRoot: string): Set<number> {
  const root = stateRoot(repoRoot);
  const ports = new Set<number>();
  if (!fs.existsSync(root)) return ports;
  for (const name of fs.readdirSync(root)) {
    const metaPath = path.join(root, name, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta: Meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        ports.add(meta.port);
      } catch {
        /* ignore malformed meta */
      }
    }
  }
  return ports;
}

export function nextFreePort(repoRoot: string): number {
  const used = usedPorts(repoRoot);
  let port = BASE_PORT;
  while (used.has(port)) port++;
  return port;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function currentBranch(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function assertFeatureFree(repoRoot: string, feature: string): string {
  const metaPath = featureFile(repoRoot, feature, "meta");
  if (fs.existsSync(metaPath)) {
    throw new Error(
      `feature "${feature}" มีอยู่แล้ว (เจอ ${metaPath}) — ถ้าทำเสร็จ/เลิกใช้แล้วให้ "pmctl clean ${feature}" ก่อน ` +
        `หรือถ้าจะเริ่มงานใหม่ให้ใช้ชื่อ feature อื่น`,
    );
  }
  return metaPath;
}

function writeMeta(repoRoot: string, feature: string, meta: Meta): Meta {
  ensureFeatureDir(repoRoot, feature);
  fs.writeFileSync(featureFile(repoRoot, feature, "meta"), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Default mode: no new branch, no new worktree. Runs PM/Dev/Tester directly
 * in repoRoot, on whatever branch is already checked out there. This is the
 * right choice for solo/sequential work where isolation between features
 * doesn't matter and the PO doesn't want pmctl touching git branches at all.
 */
export function useCurrentCheckout(repoRoot: string, feature: string, clickupTaskId?: string): Meta {
  assertFeatureFree(repoRoot, feature);
  const branch = currentBranch(repoRoot);
  const meta: Meta = {
    feature,
    branch,
    worktreePath: repoRoot,
    port: nextFreePort(repoRoot),
    clickupTaskId,
    createdAt: new Date().toISOString(),
  };
  // Deliberately does not touch .env.local here — repoRoot is the user's own
  // working copy, possibly already running a dev server on their own port.
  return writeMeta(repoRoot, feature, meta);
}

/**
 * Opt-in isolated mode: creates a separate git worktree (and so a separate
 * working directory + dev server port) for this feature, checked out onto an
 * existing branch. pmctl still does not create or delete the branch itself —
 * that stays the PO's call — it only fails clearly if the branch is missing.
 * Use this when running more than one feature at a time and you need them to
 * not collide on files or ports.
 */
export function createIsolatedWorktree(
  repoRoot: string,
  feature: string,
  clickupTaskId?: string,
  branchOverride?: string,
): Meta {
  assertFeatureFree(repoRoot, feature);
  const repoName = path.basename(repoRoot);
  const worktreePath = path.join(path.dirname(repoRoot), `${repoName}-${feature}`);
  const branch = branchOverride ?? `feature/${feature}`;
  const port = nextFreePort(repoRoot);

  if (!branchExists(repoRoot, branch)) {
    throw new Error(
      `ไม่พบ branch "${branch}" — pmctl ไม่สร้าง branch ให้เองแล้ว กรุณาสร้างเองก่อน เช่น "git branch ${branch}" ` +
        `(หรือถ้าอยากใช้ branch ชื่ออื่น ใช้ --branch <ชื่อ> ตอนรัน pmctl run)`,
    );
  }

  if (fs.existsSync(worktreePath)) {
    // A leftover worktree directory from a previous incomplete run. This is
    // pmctl's own working-copy folder, not the user's branch, so it's safe to
    // clean up automatically — unlike the branch itself. Try to let git clean
    // it up properly first (in case it's still registered), then fall back to
    // a plain filesystem removal.
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  execFileSync("git", ["worktree", "add", worktreePath, branch], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  fs.writeFileSync(path.join(worktreePath, ".env.local"), `PORT=${port}\n`);

  const meta: Meta = {
    feature,
    branch,
    worktreePath,
    port,
    clickupTaskId,
    createdAt: new Date().toISOString(),
  };
  return writeMeta(repoRoot, feature, meta);
}

export function loadMeta(repoRoot: string, feature: string): Meta {
  const metaPath = featureFile(repoRoot, feature, "meta");
  if (!fs.existsSync(metaPath)) {
    throw new Error(`ไม่พบ feature "${feature}" — ยังไม่ได้ pmctl run มาก่อนหรือเปล่า`);
  }
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

export function removeWorktree(repoRoot: string, feature: string): void {
  const meta = loadMeta(repoRoot, feature);
  if (path.resolve(meta.worktreePath) === path.resolve(repoRoot)) {
    // This feature ran in-place (useCurrentCheckout) — there's no separate
    // worktree to remove, and the directory IS the repo the user is standing
    // in, so there's nothing to do here beyond what `clean` already does for
    // .pmctl/<feature> state.
    console.log(`[pmctl] feature "${feature}" รันแบบ in-place ไม่มี worktree แยกให้ลบ`);
    return;
  }
  execFileSync("git", ["worktree", "remove", meta.worktreePath, "--force"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
