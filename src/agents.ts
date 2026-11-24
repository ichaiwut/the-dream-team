import { spawn, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Meta } from "./worktree.js";
import { FILES, featureDir, featureFile } from "./paths.js";
import { CLICKUP_WRITE_TOOLS } from "./clickupTools.js";
import { ensureClaudeBashAllowRule } from "./claudeSettings.js";
import { estimateTokens } from "./sessionStats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = path.join(__dirname, "..", "roles");
/**
 * pmctl's own entry point, as an absolute path. PM shells out to this to
 * append log lines, so it must not depend on `pmctl` being on PATH inside
 * whatever environment the sub-process inherits — this is the same file
 * that's already running.
 */
const CLI_ENTRY = path.join(__dirname, "cli.js");

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== "string") {
      // A var referenced in a template but missing from buildVars used to
      // fail in two silent ways at once: `{{X}}` survived into the role
      // text an agent is handed, and `${vars.X}` elsewhere rendered the
      // string "undefined" into its prompt. Both produce an agent
      // confidently told to read a file called "undefined", which looks
      // like the agent ignoring instructions rather than a typo here.
      throw new Error(`fillTemplate: ตัวแปร ${key} ไม่มีค่า (ต้องเพิ่มใน buildVars)`);
    }
    out = out.split(`{{${key}}}`).join(value);
  }
  const leftover = [...new Set(out.match(/\{\{[A-Z_][A-Z0-9_]*\}\}/g) ?? [])];
  if (leftover.length > 0) {
    throw new Error(
      `fillTemplate: เหลือ placeholder ที่ไม่มีใครแทนค่า: ${leftover.join(", ")} — ` +
        `เพิ่มตัวแปรนี้ใน buildVars() หรือแก้ชื่อใน template ให้ตรง`
    );
  }
  return out;
}

function buildVars(repoRoot: string, meta: Meta): Record<string, string> {
  const dir = featureDir(repoRoot, meta.feature);
  return {
    SPEC_PATH: path.join(dir, FILES.spec),
    PLAN_PATH: path.join(dir, FILES.plan),
    ANSWERS_PATH: path.join(dir, FILES.answers),
    DEV_SUMMARY_PATH: path.join(dir, FILES.devSummary),
    PO_BRIEF_PATH: path.join(dir, FILES.poBrief),
    PO_MESSAGES_PATH: path.join(dir, FILES.poMessages),
    COMMIT_MESSAGE_PATH: path.join(dir, FILES.commitMessage),
    DEV_PROMPT_PATH: path.join(dir, FILES.devPrompt),
    REVIEWER_PROMPT_PATH: path.join(dir, FILES.reviewerPrompt),
    TESTER_PROMPT_PATH: path.join(dir, FILES.testerPrompt),
    // Concrete, runnable command for appending a log line — see the
    // log-append subcommand in src/cli.ts for why PM must not hand-encode
    // the JSON itself.
    LOG_APPEND_CMD: `node ${CLI_ENTRY} log-append ${meta.feature}`,
    REVIEW_PATH: path.join(dir, FILES.review),
    REPORT_PATH: path.join(dir, FILES.report),
    LOG_PATH: path.join(dir, FILES.log),
    WORKTREE_PATH: meta.worktreePath,
    PORT: String(meta.port),
    // Rendered copies, not the originals in roles/ — see renderSubAgentRoles
    // below. PM reads these with its own Read tool and pastes the content
    // into each sub-agent's --append-system-prompt verbatim, so any
    // {{VAR}} left unfilled would reach the sub-agent as literal braces.
    DEV_ROLE_PATH: path.join(dir, "roles", "dev.md"),
    REVIEWER_ROLE_PATH: path.join(dir, "roles", "reviewer.md"),
    TESTER_ROLE_PATH: path.join(dir, "roles", "tester.md"),
    // Where PM tees each sub-agent's raw --output-format json reply, purely
    // so src/runView.tsx can tail a readable transcript per agent. PM still
    // reads the JSON from its own bash tool's stdout as before — `tee` just
    // makes a second copy, it doesn't change what PM itself sees.
    DEV_SESSION_LOG: path.join(dir, FILES.devSession),
    REVIEWER_SESSION_LOG: path.join(dir, FILES.reviewerSession),
    TESTER_SESSION_LOG: path.join(dir, FILES.testerSession),
    // Same blocklist PM itself is spawned with (src/clickupTools.ts). PM's
    // role prompt uses this to pass --disallowedTools when it spawns Dev,
    // Reviewer and Tester, so "no ClickUp access" is enforced at the
    // permission level for all four roles, not just told to PM in prose.
    CLICKUP_DISALLOWED_TOOLS: CLICKUP_WRITE_TOOLS.join(","),
  };
}

/**
 * Writes template-filled copies of the Dev/Reviewer/Tester role files into
 * the feature's own state dir, and returns nothing — buildVars already
 * points DEV_ROLE_PATH and friends at these copies.
 *
 * PM hands each sub-agent its role by reading the file and pasting the text
 * into --append-system-prompt (it can't use `$(cat ...)`: Claude Code's Bash
 * tool refuses command substitution). That means whatever is in the file is
 * what the sub-agent sees, character for character — so a `{{DEV_SUMMARY_PATH}}`
 * left in there arrives as literal braces and the sub-agent has no idea
 * where to write. Only pm.md was ever filled in; these three were passed
 * through raw, which was fine only as long as they contained no variables.
 */
function renderSubAgentRoles(dir: string, vars: Record<string, string>): void {
  const outDir = path.join(dir, "roles");
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ["dev.md", "reviewer.md", "tester.md"]) {
    const template = fs.readFileSync(path.join(ROLES_DIR, name), "utf8");
    fs.writeFileSync(path.join(outDir, name), fillTemplate(template, vars), "utf8");
  }
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
  /**
   * Estimated tokens of prompt this invocation starts with (initial prompt
   * + appended system prompt). PM runs in plain text mode and reports no
   * usage of its own, so this is the one honest thing that can be said
   * about its context: how much pmctl put in before it did anything.
   */
  promptTokens: number;
}

/**
 * Which part of the pipeline this particular PM invocation should run.
 * Each `claude -p` call is one-shot and can't pause mid-session for a human
 * to answer, so the plan-approval gate (see src/runView.tsx) is built as
 * two separate invocations rather than one that "waits":
 *   - "initial": steps 0-1 only (fetch spec, write plan.md), then PM stops
 *     and logs plan_awaiting_approval — never touches Dev in this call.
 *   - "continueAfterApproval": spec.md/plan.md already exist and the PO has
 *     approved; skip straight to step 2 (dispatch Dev) onward.
 *   - "fullRunNoGate": the old all-in-one behavior, no stopping point at
 *     all. Used for the non-interactive/headless fallback (spawnPmSession
 *     below), since there's no terminal there for a human to approve with.
 */
export type PmPhase = "initial" | "dev" | "reviewer" | "tester" | "final" | "fullRunNoGate";

/**
 * The stage each gated phase covers, as a sentence PM gets verbatim. Every
 * one of these ends the same way: do this stage, log it, stop. The PO is
 * asked between each, so a phase that "helpfully" runs the next stage too
 * silently removes a checkpoint the PO is waiting at.
 */
const PHASE_INSTRUCTION: Record<Exclude<PmPhase, "fullRunNoGate">, string> = {
  initial:
    `ก่อนอื่นใช้ Read tool เช็คไฟล์ po-brief.md และ po-messages.md (path อยู่ใน role ของคุณ) — ถ้ามีและไม่ว่าง นั่นคือสิ่งที่ PO พิมพ์สั่งไว้เอง ` +
    `ก่อนเริ่มงาน ให้ถือเป็นคำสั่งที่มีน้ำหนักเหนือการตีความ spec ของคุณเอง แล้วค่อยทำตามบทบาท PM ` +
    `เฉพาะขั้นตอน 0-1 เท่านั้น (ดึง spec จาก ClickUp เขียน spec.md -> วางแผน -> เขียน plan.md) ` +
    `แล้วหยุดทันที รอ PO อนุมัติ ห้ามสั่ง Dev ในรอบนี้เด็ดขาด`,
  dev:
    `ทำเฉพาะขั้นตอน 2 (สั่ง Dev) เท่านั้น — สั่ง Dev หนึ่งรอบ รอผล อ่านไฟล์สรุปของ Dev ` +
    `แล้ว append log "step":"dev_done" พร้อมสรุปสั้นๆ แล้ว**หยุดทันที** ` +
    `**ห้ามสั่ง Reviewer ในรอบนี้เด็ดขาด** ไม่ว่าโค้ดจะดูเรียบร้อยแค่ไหน — PO ต้องอ่านสรุปของ Dev แล้วกดอนุมัติก่อนเสมอ`,
  reviewer:
    `ทำเฉพาะขั้นตอน 3 (สั่ง Reviewer ตรวจโค้ด) เท่านั้น — สั่ง Reviewer หนึ่งรอบ อ่านผลจาก review.md ` +
    `แล้ว append log "step":"reviewer_done" (ถ้า PASS) หรือ "step":"iteration" (ถ้า FAIL) แล้ว**หยุดทันที** ` +
    `**ห้ามสั่ง Tester และห้ามสั่ง Dev แก้ต่อในรอบนี้เด็ดขาด** — PO ต้องอ่านผลตรวจแล้วกดอนุมัติก่อนเสมอ`,
  tester:
    `ทำเฉพาะขั้นตอน 4 (สั่ง Tester) เท่านั้น — สั่ง Tester หนึ่งรอบ อ่านผลจาก report.md ` +
    `แล้ว append log "step":"tester_done" (ถ้าผ่าน) หรือ "step":"iteration" (ถ้า fail) แล้ว**หยุดทันที** ` +
    `**ห้ามสั่ง Dev แก้ต่อในรอบนี้เด็ดขาด** — PO ต้องอ่านผลเทสต์แล้วกดอนุมัติก่อนเสมอ`,
  final:
    `ทำเฉพาะขั้นตอน 6 (จบงาน) เท่านั้น — เขียน section "## สถานะสุดท้าย" ต่อท้าย plan.md, ` +
    `เขียนข้อความ commit ลงไฟล์ตามที่ role ของคุณระบุ (COMMIT_MESSAGE_PATH) เพราะ pmctl จะเอาไปใช้ commit จริง, ` +
    `แล้ว append log "step":"final_done" แล้วหยุด ไม่ต้องสั่ง agent ตัวไหนอีก และ**ห้ามรัน git commit เอง**`,
};

/** Wire name for a phase, as it appears on the `PHASE:` line PM reads. */
const PHASE_WIRE_NAME: Record<PmPhase, string> = {
  initial: "initial",
  dev: "dev",
  reviewer: "reviewer",
  tester: "tester",
  final: "final",
  fullRunNoGate: "full-run-no-gate",
};

function buildInitialPrompt(phase: PmPhase, clickupRef: string, vars: Record<string, string>): string {
  const header = `ClickUp task ของ feature นี้คือ: ${clickupRef}\n`;

  if (phase === "fullRunNoGate") {
    return (
      header +
      `PHASE: full-run-no-gate\n` +
      `ทำตามบทบาท PM ของคุณให้ครบทุกขั้นตอน ` +
      `(ดึง spec จาก ClickUp เขียน spec.md -> วางแผน -> เขียน plan.md -> สั่ง Dev -> สั่ง Reviewer -> สั่ง Tester -> วนแก้ถ้า fail -> สรุปจบ)`
    );
  }

  // Every gated phase after the first resumes work already on disk, so it
  // starts the same way: read what's there, pick up any answer the PO typed
  // at the gate, then do exactly one stage.
  const resumeContext =
    phase === "initial"
      ? ""
      : `spec.md (${vars.SPEC_PATH}) และ plan.md (${vars.PLAN_PATH}) มีอยู่แล้วจากรอบก่อนหน้า ` +
        `และ PO อนุมัติให้ทำขั้นตอนนี้ต่อแล้ว **ข้ามขั้นตอน 0 และ 1 ไปเลย** อย่าไปเขียน spec.md หรือ plan.md ใหม่ซ้ำ ` +
        `ก่อนอื่น ใช้ Read tool เช็คสองไฟล์นี้เสมอ: ` +
        `(1) ${vars.PO_MESSAGES_PATH} — ข้อความที่ PO พิมพ์สั่งระหว่างทาง ทุกข้อถือว่ายังมีผลอยู่ ` +
        `ข้อความใหม่กว่าชนะถ้าขัดกันเอง และมีน้ำหนักเหนือการตีความ spec ของคุณเอง ` +
        `**และให้อ่านไฟล์นี้ซ้ำอีกครั้งทันทีที่ sub-agent ตอบกลับมา** ก่อนตัดสินใจขั้นต่อไป เพราะ PO พิมพ์มาได้ตลอดเวลา ` +
        `ระหว่างที่ sub-agent รันอยู่ — แล้วคุณเป็นคนตัดสินใจเองว่าจะปล่อยให้งานนั้นผ่าน, ทิ้งแล้วสั่งใหม่, หรือหยุดรายงาน PO ` +
        `(pmctl ไม่ interrupt อะไรให้ และห้ามส่งไฟล์นี้ต่อให้ sub-agent อ่านเอง ให้แปลงเป็นคำสั่งของคุณเอง) ` +
        `(2) ${vars.ANSWERS_PATH} — คำตอบที่ PO พิมพ์ตอบคำถามของคุณที่ gate ล่าสุด ` +
        `ให้เพิ่ม section "## คำตอบจาก PO" ต่อท้าย plan.md แล้วนำไปใช้ในคำสั่งที่จะส่งต่อในรอบนี้ ` +
        `(ไฟล์ไหนไม่มีหรือว่าง แปลว่าไม่มีอะไรเพิ่มจากทางนั้น ทำต่อตาม plan.md เดิมได้) `;

  return (
    header +
    `PHASE: ${PHASE_WIRE_NAME[phase]}\n` +
    resumeContext +
    PHASE_INSTRUCTION[phase] +
    `\nคำตอบสุดท้ายของคุณในรอบนี้คือสรุปสั้นๆ ให้ PO อ่านเร็วว่าขั้นตอนนี้ได้อะไร และถ้ามีอะไรที่ต้องให้ PO ตัดสินใจ ให้ถามมาในนั้นเลย`
  );
}

/**
 * Builds everything needed to spawn one PM invocation (args, cwd, a log file
 * stream, and the human-readable startup notice) without actually spawning
 * it. Shared by the plain headless path (spawnPmSession below) and the
 * interactive TUI path (src/runView.tsx), so both stay in sync on exactly
 * what gets passed to `claude`. `phase` picks which part of the pipeline
 * this particular call covers — see PmPhase above.
 */
export function buildPmSessionPlan(
  repoRoot: string,
  meta: Meta,
  permissionMode: string,
  clickupRef: string,
  phase: PmPhase = "fullRunNoGate"
): PmSessionPlan {
  const vars = buildVars(repoRoot, meta);
  // Known per invocation rather than per feature, so it's added here
  // instead of in buildVars.
  vars.CLICKUP_REF = clickupRef;
  // Dev/Reviewer/Tester are spawned by PM's own Bash tool as nested, fully
  // headless `claude -p` calls with no human attached. Any Bash command one
  // of them runs that isn't already covered by an allow rule in
  // .claude/settings.local.json hits an interactive approval prompt — which
  // just hangs forever in -p mode, since nothing can answer it (a real run
  // hit this on a plain `cp *.png ...`, not anything exotic). "acceptEdits"
  // only auto-approves Edit/Write tool calls, not Bash, so it never
  // prevented this. roles/pm.md now passes this through to Dev/Reviewer/
  // Tester's own --permission-mode instead of hardcoding "acceptEdits",
  // so whatever mode the PO chose for PM (see src/cli.ts's --permission-mode
  // default) governs the sub-agents too, rather than silently overriding it.
  vars.SUB_AGENT_PERMISSION_MODE = permissionMode;
  renderSubAgentRoles(featureDir(repoRoot, meta.feature), vars);
  const pmRoleTemplate = fs.readFileSync(path.join(ROLES_DIR, "pm.md"), "utf8");
  const pmSystemPrompt = fillTemplate(pmRoleTemplate, vars);

  // Best-effort: without this, PM's nested `claude -p ...` calls to spawn
  // Dev/Reviewer/Tester can hang on an interactive Bash-approval prompt that
  // has no human attached to answer it (PM runs headless, via -p). See
  // src/claudeSettings.ts for why this is a guess, not a verified fix.
  ensureClaudeBashAllowRule(meta.worktreePath);

  const initialPrompt = buildInitialPrompt(phase, clickupRef, vars);

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
    `(ดู src/clickupTools.ts ว่าบล็อกครบไหมก่อนใช้งานจริง)\n` +
    `[pmctl] เพิ่ม allow rule "Bash(claude -p *)" ให้ ${meta.worktreePath}/.claude/settings.local.json แล้ว (ถ้ายังไม่มี) ` +
    `เพื่อให้ PM สั่ง Dev/Reviewer/Tester ผ่าน bash ได้โดยไม่ติด approval prompt ที่ไม่มีใครตอบ — ` +
    `syntax นี้เดายังไม่ได้ verify กับ claude CLI จริง ถ้ายังเจอ "this command requires approval" ` +
    `ให้รัน claude แบบ interactive ในโฟลเดอร์นี้สักครั้ง กด allow ให้คำสั่ง claude -p แล้วเลือก "always allow" ` +
    `ตัว CLI จะเขียน syntax ที่ถูกต้องลงไฟล์เดียวกันนี้เอง\n`;

  return {
    args,
    cwd: meta.worktreePath,
    logFile,
    notice,
    promptTokens: estimateTokens(initialPrompt) + estimateTokens(pmSystemPrompt),
  };
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
  vars.CLICKUP_REF = clickupRef;

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
