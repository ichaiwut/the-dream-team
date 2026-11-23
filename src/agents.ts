import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Meta } from "./worktree.js";
import { FILES, featureDir, featureFile } from "./paths.js";

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
    REPORT_PATH: path.join(dir, FILES.report),
    LOG_PATH: path.join(dir, FILES.log),
    WORKTREE_PATH: meta.worktreePath,
    PORT: String(meta.port),
    DEV_ROLE_PATH: path.join(ROLES_DIR, "dev.md"),
    TESTER_ROLE_PATH: path.join(ROLES_DIR, "tester.md"),
  };
}

/**
 * Spawns the PM session. This is the ONLY claude process pmctl itself
 * spawns directly — PM is given bash access (via claude's own tools) and
 * is instructed, in roles/pm.md, to spawn Dev and Tester itself as further
 * `claude -p` subprocesses. pmctl does not orchestrate Dev/Tester directly;
 * that is PM's job, by design, so PM is a real reasoning agent in the loop
 * rather than a dumb pass-through.
 *
 * Enforcement note: CLICKUP_API_TOKEN is intentionally stripped from the
 * child environment so PM (and anything it spawns) cannot call the
 * ClickUp API even if instructed to try.
 */
export function spawnPmSession(repoRoot: string, meta: Meta, permissionMode: string): Promise<number> {
  const vars = buildVars(repoRoot, meta);
  const pmRoleTemplate = fs.readFileSync(path.join(ROLES_DIR, "pm.md"), "utf8");
  const pmSystemPrompt = fillTemplate(pmRoleTemplate, vars);

  const initialPrompt =
    `อ่าน spec ที่ ${vars.SPEC_PATH} แล้วทำตามบทบาท PM ของคุณให้ครบทุกขั้นตอน ` +
    `(วางแผน -> เขียน plan.md -> สั่ง Dev -> สั่ง Tester -> วนแก้ถ้า fail -> สรุปจบ)`;

  const env = { ...process.env };
  delete env.CLICKUP_API_TOKEN;

  const logFile = fs.createWriteStream(featureFile(repoRoot, meta.feature, "pmSession"), { flags: "a" });

  const args = [
    "-p",
    initialPrompt,
    "--append-system-prompt",
    pmSystemPrompt,
    "--permission-mode",
    permissionMode,
  ];

  console.log(
    `\n[pmctl] กำลังเริ่ม PM session ใน ${meta.worktreePath} (port ${meta.port})\n` +
      `[pmctl] หมายเหตุ: ถ้า claude CLI เครื่องนี้ไม่รู้จัก flag ด้านบน ให้รัน "claude --help" เช็คชื่อ flag ปัจจุบันแล้วแก้ใน src/agents.ts\n`
  );

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: meta.worktreePath,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logFile.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logFile.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      logFile.end();
      resolve(code ?? 0);
    });
  });
}
