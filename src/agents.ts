import { spawn } from "node:child_process";
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
    REPORT_PATH: path.join(dir, FILES.report),
    LOG_PATH: path.join(dir, FILES.log),
    WORKTREE_PATH: meta.worktreePath,
    PORT: String(meta.port),
    DEV_ROLE_PATH: path.join(ROLES_DIR, "dev.md"),
    TESTER_ROLE_PATH: path.join(ROLES_DIR, "tester.md"),
  };
}

interface RunClaudeOptions {
  args: string[];
  cwd: string;
  logFile?: fs.WriteStream;
}

function runClaude({ args, cwd, logFile }: RunClaudeOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["inherit", "pipe", "pipe"] });

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
 * Spawns the PM session. This is the ONLY claude process pmctl itself
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
 */
export function spawnPmSession(
  repoRoot: string,
  meta: Meta,
  permissionMode: string,
  clickupRef: string
): Promise<number> {
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

  console.log(
    `\n[pmctl] กำลังเริ่ม PM session ใน ${meta.worktreePath} (port ${meta.port})\n` +
      `[pmctl] หมายเหตุ: ถ้า claude CLI เครื่องนี้ไม่รู้จัก --append-system-prompt/--permission-mode/--disallowedTools ` +
      `ให้รัน "claude --help" เช็คชื่อ flag ปัจจุบันแล้วแก้ใน src/agents.ts\n` +
      `[pmctl] PM จะใช้ ClickUp connector ของบัญชีนี้เอง — tool เขียนของ ClickUp ถูกบล็อกผ่าน --disallowedTools ` +
      `(ดู src/clickupTools.ts ว่าบล็อกครบไหมก่อนใช้งานจริง)\n`
  );

  return runClaude({ args, cwd: meta.worktreePath, logFile });
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
