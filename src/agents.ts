import { spawn, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Meta } from "./worktree.js";
import { FILES, featureDir, featureFile } from "./paths.js";
import { CLICKUP_WRITE_TOOLS } from "./clickupTools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = path.join(__dirname, "..", "roles");

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

function buildVars(repoRoot: string, meta: Meta): Record<string, string> {
  const dir = featureDir(repoRoot, meta.feature);
  return {
    SPEC_PATH: path.join(dir, FILES.spec),
    PLAN_PATH: path.join(dir, FILES.plan),
    REVIEW_PATH: path.join(dir, FILES.review),
    REPORT_PATH: path.join(dir, FILES.report),
    LOG_PATH: path.join(dir, FILES.log),
    WORKTREE_PATH: meta.worktreePath,
    PORT: String(meta.port),
    DEV_ROLE_PATH: path.join(ROLES_DIR, "dev.md"),
    REVIEWER_ROLE_PATH: path.join(ROLES_DIR, "reviewer.md"),
    TESTER_ROLE_PATH: path.join(ROLES_DIR, "tester.md"),
    // Same blocklist PM itself is spawned with (src/clickupTools.ts). PM's
    // role prompt uses this to pass --disallowedTools when it spawns Dev,
    // Reviewer and Tester, so "no ClickUp access" is enforced at the
    // permission level for all four roles, not just told to PM in prose.
    CLICKUP_DISALLOWED_TOOLS: CLICKUP_WRITE_TOOLS.join(","),
  };
}

interface RunClaudeOptions {
  args: string[];
  cwd: string;
  logFile?: fs.WriteStream;
}

function runClaude({ args, cwd, logFile }: RunClaudeOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnClaudeProcess(args, cwd);

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logFile?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logFile?.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      logFile?.end();
      resolve(code ?? 0);
    });
  });
}

/**
 * Raw `claude` subprocess spawn, with no stdout/stderr handling attached.
 * Exported so an interactive UI (src/runView.tsx) can attach its own
 * listeners (to render output instead of writing it straight to stdout)
 * while still sharing the exact same argument-building logic below.
 */
export function spawnClaudeProcess(args: string[], cwd: string): ChildProcessByStdio<null, Readable, Readable> {
  return spawn("claude", args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
}

export interface PmSessionPlan {
  args: string[];
  cwd: string;
  logFile: fs.WriteStream;
  notice: string;
}

/**
 * Builds everything needed to spawn the PM session (args, cwd, a log file
 * stream, and the human-readable startup notice) without actually spawning
 * it. Shared by the plain headless path (spawnPmSession below) and the
 * interactive TUI path (src/runView.tsx), so both stay in sync on exactly
 * what gets passed to `claude`.
 */
export function buildPmSessionPlan(
  repoRoot: string,
  meta: Meta,
  permissionMode: string,
  clickupRef: string
): PmSessionPlan {
  const vars = buildVars(repoRoot, meta);
  const pmRoleTemplate = fs.readFileSync(path.join(ROLES_DIR, "pm.md"), "utf8");
  const pmSystemPrompt = fillTemplate(pmRoleTemplate, vars);

  const initialPrompt =
    `ClickUp task ของ feature นี้คือ: ${clickupRef}\n` +
    `ทำตามบทบาท PM ของคุณให้ครบทุกขั้นตอน ` +
    `(ดึง spec จาก ClickUp เขียน spec.md -> วางแผน -> เขียน plan.md -> สั่ง Dev -> สั่ง Tester -> วนแก้ถ้า fail -> สรุปจบ)`;

  const logFile = fs.createWriteStream(featureFile(repoRoot, meta.feature, "pmSession"), { flags: "a" });

  const args = [
    "-p",
    initialPrompt,
    "--append-system-prompt",
    pmSystemPrompt,
    "--permission-mode",
    permissionMode,
    "--disallowedTools",
    CLICKUP_WRITE_TOOLS.join(","),
  ];

  const notice =
    `\n[pmctl] กำลังเริ่ม PM session ใน ${meta.worktreePath} (port ${meta.port})\n` +
    `[pmctl] หมายเหตุ: ถ้า claude CLI เครื่องนี้ไม่รู้จัก --append-system-prompt/--permission-mode/--disallowedTools ` +
    `ให้รัน "claude --help" เช็คชื่อ flag ปัจจุบันแล้วแก้ใน src/agents.ts\n` +
    `[pmctl] PM จะใช้ ClickUp connector ของบัญชีนี้เอง — tool เขียนของ ClickUp ถูกบล็อกผ่าน --disallowedTools ` +
    `(ดู src/clickupTools.ts ว่าบล็อกครบไหมก่อนใช้งานจริง)\n`;

  return { args, cwd: meta.worktreePath, logFile, notice };
}

/**
 * Spawns the PM session in plain, non-interactive (headless) mode: output
 * streams straight to stdout. This is the ONLY claude process pmctl itself
 * spawns directly — PM is given bash access (via claude's own tools) and
 * is instructed, in roles/pm.md, to spawn Dev and Tester itself as further
 * `claude -p` subprocesses. pmctl does not orchestrate Dev/Tester directly;
 * that is PM's job, by design, so PM is a real reasoning agent in the loop
 * rather than a dumb pass-through.
 *
 * ClickUp access: PM uses your own already-authenticated ClickUp MCP
 * connector to read the task (no separate token needed). Write access to
 * ClickUp is blocked via --disallowedTools against every write-capable
 * ClickUp tool name known at the time clickupTools.ts was written — see
 * the warning in that file about this being a blocklist, not a structural
 * guarantee the way withholding a credential would be.
 *
 * Used as a fallback when stdin/stdout aren't a real TTY (the interactive
 * TUI in src/runView.tsx needs raw-mode terminal support); see src/cli.ts.
 */
export function spawnPmSession(
  repoRoot: string,
  meta: Meta,
  permissionMode: string,
  clickupRef: string
): Promise<number> {
  const plan = buildPmSessionPlan(repoRoot, meta, permissionMode, clickupRef);
  console.log(plan.notice);
  return runClaude({ args: plan.args, cwd: plan.cwd, logFile: plan.logFile });
}

/**
 * A short, one-off claude call that just re-fetches the ClickUp task and
 * overwrites spec.md — used by `pmctl refresh-spec`. Same ClickUp
 * read-access-via-connector / write-blocked-via-disallowedTools setup as
 * the PM session, but with no bash access needed beyond writing one file,
 * and no Dev/Tester dispatch.
 */
export function spawnRefreshSpec(repoRoot: string, meta: Meta, clickupRef: string): Promise<number> {
  const vars = buildVars(repoRoot, meta);

  const prompt =
    `ใช้ ClickUp tool ของคุณ (เช่น clickup_get_task — ถ้า ref เป็น custom id พร้อม URL ที่มี team id ` +
    `ให้ส่ง custom_task_ids=true และ team_id ตามใน URL ด้วย) ดึงรายละเอียด task นี้มาใหม่: ${clickupRef}\n` +
    `แล้วเขียนทับไฟล์ ${vars.SPEC_PATH} ด้วยรูปแบบ markdown เดิม (หัวข้อชื่อ task, ที่มา, สถานะ, รายละเอียด, custom fields) ` +
    `ไม่ต้องทำอย่างอื่นนอกจากนี้`;

  return runClaude({
    args: ["-p", prompt, "--permission-mode", "acceptEdits", "--disallowedTools", CLICKUP_WRITE_TOOLS.join(",")],
    cwd: meta.worktreePath,
  });
}
