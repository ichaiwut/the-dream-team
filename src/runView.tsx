import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import { Meta } from "./worktree.js";
import { readLog, readLogSafe, LogEntry } from "./log.js";
import { featureFile, FILES } from "./paths.js";
import { buildPmSessionPlan, spawnClaudeProcess, PmPhase, type PmSessionPlan } from "./agents.js";
// PIPELINE/checklist logic lives in pipeline.ts so plan.html's flow chart
// (planHtml.ts) computes the exact same checklist the TUI shows here,
// instead of drifting out of sync with a second copy of this logic.
import {
  computeChecklist,
  checklistColor,
  checklistMark,
  formatAge,
  openGate,
  finalDoneIndex,
  phaseAfterLog,
  type Gate,
} from "./pipeline.js";
import {
  buildStageHtml,
  buildFinalReportHtml,
  openInBrowser,
  hasOpenQuestions,
  hasUnresolvedAgentQuestions,
} from "./planHtml.js";
import { notify } from "./notify.js";
import { collectRunDiff } from "./gitDiff.js";
import {
  listPendingChanges,
  commitWork,
  readCommitMessage,
  recordGitBaseline,
  type CommitResult,
} from "./gitCommit.js";
import {
  readSessionStats,
  formatSessionStats,
  estimateTokens,
  formatEstimatedTokens,
  ASSUMED_CONTEXT_WINDOW,
  type SessionStats,
} from "./sessionStats.js";

const LOG_POLL_MS = 1000;
const MAX_LINES = 2000;

// Anthropic's API occasionally returns a transient server-side error (529
// overloaded is the common one, but rate limits and 5xx gateway errors show
// up the same way) that has nothing to do with PM's own work — the fix is
// just "try again shortly," not stopping the whole `pmctl run` and making
// the PO re-run it by hand. Matched against this invocation's own raw
// stdout/stderr text when it exits non-zero.
const TRANSIENT_ERROR_PATTERNS = [
  /\b529\b/,
  /overloaded/i,
  /\b50[0-4]\b.*(error|gateway)/i,
  /rate.?limit/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /socket hang up/i,
];
function isTransientError(text: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(text));
}
const MAX_TRANSIENT_RETRIES = 5;
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 60000];

// How long one pipeline step can sit without a new log line before its age
// is shown in red. Not a timeout and nothing acts on it — a real Dev change
// or a full e2e run can legitimately take longer. It only marks the point
// where "is it stuck?" stops being paranoia, which is the exact question
// the old checklist (no times at all) gave you no way to answer.
const SLOW_STEP_MS = 10 * 60 * 1000;

/** What each PM invocation is there to do, for the "กำลังรัน" line. */
const PHASE_LABEL: Record<PmPhase, string> = {
  initial: "ดึง spec + วางแผน",
  dev: "สั่ง Dev เขียนโค้ด",
  reviewer: "สั่ง Reviewer ตรวจโค้ด",
  tester: "สั่ง Tester รัน e2e",
  final: "สรุปปิดงาน",
  fullRunNoGate: "รันทุกขั้นตอนรวด (ไม่มี gate)",
};

/**
 * How long a freshly-spawned PM can go without writing a log line before
 * the TUI stops implying everything is fine and says what might be wrong.
 *
 * Booting `claude`, reading the role file and spec, and thinking before the
 * first tool call genuinely takes a while, so an early silence means
 * nothing. Past this it's worth naming the two things it's usually waiting
 * on, because they look identical from outside: still working, or blocked
 * on a tool-permission prompt that nothing in a headless `-p` session can
 * ever answer.
 */
const PHASE_SILENT_HINT_MS = 90 * 1000;

/**
 * Output that suggests the sub-process is sitting on a permission decision.
 * Treated as corroboration for the silence above, never as the trigger on
 * its own: the exact wording belongs to the `claude` CLI and changes
 * between versions, so a missed pattern must not mean a missed diagnosis.
 */
const PERMISSION_PATTERNS = [
  /permission/i,
  /do you want to proceed/i,
  /allow rule/i,
  /requested permissions/i,
  /needs? your approval/i,
];

// Rows the chrome around the panels takes up: title line + its blank
// margin line + each panel's own header line + its top/bottom border.
const HEADER_ROWS = 2;
const PANEL_CHROME_ROWS = 3;
const CHECKLIST_WIDTH_RATIO = 0.22;
const MIN_CHECKLIST_WIDTH = 28;
const MIN_SIDE_PANEL_WIDTH = 30;

// Which sub-agent is "active" right now, derived from the log's most recent
// `<agent>_started` entry (see computeActiveAgent below) — used to decide
// which raw --output-format json transcript (teed to its own session log by
// roles/pm.md) to show in the third panel.
type SubAgent = "dev" | "reviewer" | "tester";

const AGENT_PANEL_TITLE: Record<SubAgent, string> = {
  dev: "DEV SESSION (live)",
  reviewer: "REVIEWER SESSION (live)",
  tester: "TESTER SESSION (live)",
};

const AGENT_LOG_FILE: Record<SubAgent, "devSession" | "reviewerSession" | "testerSession"> = {
  dev: "devSession",
  reviewer: "reviewerSession",
  tester: "testerSession",
};

/**
 * Picks whichever sub-agent most recently started, by scanning the log in
 * order. Naturally follows PM back to "dev" on every iteration, since
 * roles/pm.md logs a fresh "dev_started" each time it loops Dev back in —
 * no special-casing of "iteration" needed here. Returns null before Dev has
 * ever been dispatched (steps 0/1, ClickUp fetch + plan, have no sub-agent
 * transcript to show yet).
 */
function computeActiveAgent(log: LogEntry[]): SubAgent | null {
  let agent: SubAgent | null = null;
  for (const entry of log) {
    if (entry.step === "dev_started") agent = "dev";
    else if (entry.step === "reviewer_started") agent = "reviewer";
    else if (entry.step === "tester_started") agent = "tester";
  }
  return agent;
}

/** Each sub-agent's session log is overwritten (`tee`, not `tee -a`) on every
 * fresh invocation by roles/pm.md, so reading it whole on every poll always
 * reflects that agent's current/latest round rather than every past one. */
/**
 * PM tees each sub-agent's reply here with `--output-format json`, so the
 * file is a JSON envelope, not prose: the panel was rendering the raw thing
 * — `"ttft_ms":1900`, `"credential_expires_at"`, every newline as a literal
 * `\n` — which made the one place you could read what Dev or Tester
 * actually said the least readable thing on screen. Pull the reply text out
 * and show that instead.
 *
 * Shape varies by CLI version (`result`, `text`, or a `content` array of
 * blocks), and a run can tee several objects one after another, so this
 * takes whatever it recognises and falls back to the raw text when it
 * recognises nothing — a readable-but-ugly panel beats an empty one.
 */
function extractAgentText(raw: string): string[] {
  const chunks: string[] = [];
  for (const candidate of raw.split(/\n(?=\{)/)) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) {
      if (trimmed) chunks.push(trimmed);
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const text =
        typeof parsed.result === "string"
          ? parsed.result
          : typeof parsed.text === "string"
            ? parsed.text
            : Array.isArray(parsed.content)
              ? (parsed.content as { text?: string }[]).map((b) => b?.text ?? "").join("")
              : null;
      if (text !== null) {
        chunks.push(text);
        const err = parsed.is_error === true || parsed.subtype === "error";
        if (err) chunks.push("(agent จบแบบ error — ดู log เต็มในไฟล์ session)");
      } else {
        chunks.push(trimmed);
      }
    } catch {
      chunks.push(trimmed);
    }
  }
  // The text carries real newlines once parsed; split so the panel wraps on
  // them instead of printing one enormous line.
  return splitLines(chunks.join("\n\n"));
}

/**
 * The most recent brief PM logged for this agent — the `*_started` entry's
 * reason, which roles/pm.md requires to say what was dispatched. Read from
 * the end so that after an iteration the panel shows the current round's
 * instruction, not the one from two rounds ago.
 */
function briefForAgent(log: LogEntry[], agent: SubAgent): string | null {
  const step = `${agent}_started`;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].step === step) return log[i].reason || null;
  }
  return null;
}

/**
 * Per-agent usage as a markdown table for the final report. Only the
 * sub-agents appear: PM's own session runs in plain-text mode and reports
 * no usage, so a row for it could only hold invented numbers. Returns ""
 * when nothing is known, which buildFinalReportHtml drops rather than
 * rendering an empty section.
 */
function buildStatsMarkdown(repoRoot: string, feature: string): string {
  const rows: string[] = [];
  for (const agent of ["dev", "reviewer", "tester"] as SubAgent[]) {
    const stats = readSessionStats(featureFile(repoRoot, feature, AGENT_LOG_FILE[agent]));
    if (!stats) continue;
    rows.push(`| ${agent} | ${formatSessionStats(stats)}${stats.isError ? " (จบแบบ error)" : ""} |`);
  }
  if (rows.length === 0) return "";
  return (
    `| agent | context / ต้นทุน |\n|---|---|\n${rows.join("\n")}\n\n` +
    `ตัวเลข context มาจาก \`--output-format json\` ของแต่ละ session (รวม cache read ด้วย เพราะเป็น context ที่โมเดลต้องอ่านจริง) ` +
    `เปอร์เซ็นต์เทียบกับ context window 200k ซึ่งเป็นค่าที่สมมติไว้ ไม่ได้อ่านจากตัว CLI\n\n` +
    `PM session ไม่มีตัวเลขเพราะรันแบบ plain text (\`-p\` เฉยๆ) ซึ่งไม่รายงาน usage กลับมาเลย`
  );
}

function readSubAgentStats(repoRoot: string, feature: string, agent: SubAgent | null): SessionStats | null {
  if (!agent) return null;
  return readSessionStats(featureFile(repoRoot, feature, AGENT_LOG_FILE[agent]));
}

function readSubAgentLines(repoRoot: string, feature: string, agent: SubAgent | null): string[] {
  if (!agent) return [];
  const file = featureFile(repoRoot, feature, AGENT_LOG_FILE[agent]);
  if (!fs.existsSync(file)) return [];
  try {
    return extractAgentText(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Which PM invocation `pmctl run` should start with, given whatever's
 * already on disk for this feature — so re-running `pmctl run` on a feature
 * whose plan is already written (the PO edited plan.md by hand, or just
 * came back after `pmctl run` exited) resumes sensibly instead of either
 * redoing the ClickUp fetch/plan from scratch or silently re-asking for
 * approval of work that's already past it:
 *   - no plan.md yet -> "initial" (normal start for a brand-new feature)
 *   - plan.md exists, Dev never dispatched -> "awaitingApprovalResume"
 *     (don't spawn anything yet; show the approval prompt immediately)
 *   - plan.md exists and Dev was already dispatched at some point -> treat
 *     the plan as already (implicitly) approved and continue from Dev
 */
type ResumeDecision = PmPhase | "gateResume" | "alreadyDone";

/**
 * What `pmctl run` should do when pointed at a feature that already has
 * state on disk. A run parked at any gate reopens that gate immediately
 * rather than spawning anything — the PO was being asked a question when
 * the previous run ended, and the question is still open.
 */
function determineResumePhase(repoRoot: string, feature: string): ResumeDecision {
  const planPath = featureFile(repoRoot, feature, "plan");
  if (!fs.existsSync(planPath)) return "initial";
  const log = readLog(repoRoot, feature);
  if (openGate(log)) return "gateResume";
  const next = phaseAfterLog(log);
  return next === "done" ? "alreadyDone" : next;
}

/**
 * A file that legitimately may not exist. Returns "" so the report drops
 * the section rather than printing a "not found" notice for something the
 * PO simply never wrote.
 */
function readOptionalFile(repoRoot: string, feature: string, key: "poBrief" | "poMessages"): string {
  try {
    const file = featureFile(repoRoot, feature, key);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

/** What happened at commit time, for the final report. */
function describeCommitMarkdown(commit: CommitResult | null, enabled: boolean): string {
  if (!enabled) return "ปิดการ commit อัตโนมัติไว้ (`--no-commit`) — งานยังอยู่ใน working tree ยังไม่ได้ commit";
  if (!commit) return "";
  if (commit.ok) {
    const files = commit.files.map((f) => `- \`${f}\``).join("\n");
    return `commit สำเร็จ: \`${commit.hash}\`\n\nไฟล์ที่ commit:\n\n${files}\n\nหมายเหตุ: pmctl ไม่ push ให้ และไม่ยุ่งกับ branch — push เองเมื่อพร้อม`;
  }
  return `**commit ไม่สำเร็จ** — งานยังอยู่ใน working tree ครบ ไม่ได้หายไปไหน\n\n\`\`\`\n${commit.error ?? ""}\n\`\`\``;
}

/** Which agent produced the document a gate shows. */
const GATE_AGENT: Record<Gate["source"], SubAgent | null> = {
  plan: null,
  devSummary: "dev",
  review: "reviewer",
  report: "tester",
};

const AGENT_PROMPT_FILE: Record<SubAgent, "devPrompt" | "reviewerPrompt" | "testerPrompt"> = {
  dev: "devPrompt",
  reviewer: "reviewerPrompt",
  tester: "testerPrompt",
};

/**
 * The exact prompt PM sent this agent, if PM wrote it down as instructed.
 * Falls back to null rather than to the logged summary: a paraphrase
 * presented as the prompt is worse than no prompt, because the whole point
 * is telling "the agent disobeyed" apart from "PM asked for the wrong
 * thing", and only the real text settles that.
 */
function readAgentPrompt(repoRoot: string, feature: string, agent: SubAgent): string | null {
  try {
    const file = featureFile(repoRoot, feature, AGENT_PROMPT_FILE[agent]);
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** The PM-to-agent exchange for a gate page: what was asked, what came back. */
function buildExchangeMarkdown(repoRoot: string, feature: string, agent: SubAgent): string {
  const prompt = readAgentPrompt(repoRoot, feature, agent);
  const reply = readSubAgentLines(repoRoot, feature, agent).join("\n").trim();
  if (!prompt && !reply) return "";
  const promptPart = prompt
    ? `### PM สั่งว่า\n\n\`\`\`\n${prompt}\n\`\`\`\n`
    : `### PM สั่งว่า\n\n(PM ไม่ได้บันทึก prompt ไว้ — ดู PM SESSION ในเทอร์มินัลหรือ pm-session.log)\n`;
  const replyPart = reply
    ? `### ${agent} ตอบกลับ\n\n\`\`\`\n${reply}\n\`\`\`\n`
    : `### ${agent} ตอบกลับ\n\n(ยังไม่มีคำตอบ)\n`;
  return `${promptPart}\n${replyPart}`;
}

/** Messages already in the thread, counted by their timestamp headings. */
function countPoMessages(repoRoot: string, feature: string): number {
  try {
    const file = featureFile(repoRoot, feature, "poMessages");
    if (!fs.existsSync(file)) return 0;
    return (fs.readFileSync(file, "utf8").match(/^##\s/gm) ?? []).length;
  } catch {
    return 0;
  }
}

/** Heading the stage's own content gets, in its artifact and on screen. */
const STAGE_BODY_HEADING: Record<Gate["source"], string> = {
  plan: "เนื้อหา plan",
  devSummary: "สรุปงานจาก Dev",
  review: "ผลตรวจโค้ดจาก Reviewer",
  report: "ผลทดสอบจาก Tester",
};

/**
 * The markdown a gate asks the PO to read. A missing file is reported as
 * such rather than thrown: an agent that skipped writing its report is a
 * real thing that happens, and the gate still has to open so the PO can
 * decide what to do about it — being told "no file" is itself the answer
 * to "what did Dev produce?".
 */
function readStageMarkdown(repoRoot: string, feature: string, source: Gate["source"]): string {
  const file = featureFile(repoRoot, feature, source);
  const name = FILES[source];
  try {
    if (!fs.existsSync(file)) {
      return `# ไม่พบไฟล์ ${name}\n\nขั้นตอนนี้ควรเขียน \`${name}\` ไว้ แต่ไม่มีไฟล์นี้อยู่จริง — agent อาจข้ามไป\n\nดูรายละเอียดที่เกิดขึ้นจริงได้จากช่อง PM SESSION ในเทอร์มินัล หรือ log`;
    }
    return fs.readFileSync(file, "utf8");
  } catch {
    return `# อ่าน ${name} ไม่สำเร็จ`;
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Border (1 col each side) + paddingX={1} (1 col each side) eaten by every panel.
const PANEL_INNER_PADDING = 4;

/**
 * Soft-wraps a single raw line to `width` columns, breaking on spaces where
 * possible and hard-breaking any single run longer than `width` (Thai text
 * has no spaces to break on, so long Thai runs — and URLs — always hit this
 * path). Without this, Ink's own `wrap="truncate-end"` just chops a line
 * dead at the panel edge, so most of every long line (easily most of a
 * markdown paragraph) never gets seen at all.
 */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0 || line.length <= width) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  let cur = "";
  for (let word of words) {
    while (word.length > width) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    const candidate = cur.length === 0 ? word : `${cur} ${word}`;
    if (candidate.length > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  out.push(cur);
  return out;
}

function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((l) => wrapLine(l, width));
}

interface PlanLine {
  text: string;
  heading: boolean;
}

/**
 * Turns raw plan.md markdown into lines fit for the full-width approval
 * screen: `#`-headings get stripped of their hashes and rendered bold/cyan so
 * the plan's own section structure (the "summary") is visible at a glance
 * instead of reading as an undifferentiated wall of text, and every line is
 * wrapped against the *real* full terminal width rather than a cramped
 * one-third-of-screen side panel.
 */
function renderPlanLines(raw: string, width: number): PlanLine[] {
  const out: PlanLine[] = [];
  for (const rawLine of splitLines(raw)) {
    const trimmed = rawLine.trimStart();
    const isHeading = /^#{1,6}\s/.test(trimmed);
    const content = isHeading ? trimmed.replace(/^#{1,6}\s*/, "") : rawLine;
    for (const w of wrapLine(content, width)) out.push({ text: w, heading: isHeading });
  }
  return out;
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
  briefMode,
  commitOnFinish,
  onDone,
}: {
  repoRoot: string;
  meta: Meta;
  permissionMode: string;
  clickupRef: string;
  /**
   * "ask" opens the brief box for the PO to type into; "skip" starts
   * straight away; any other string is a brief supplied on the command
   * line, pre-filled so it can still be edited before it's used.
   */
  briefMode: string;
  /** Whether approving the last gate also commits the work. */
  commitOnFinish: boolean;
  onDone: (code: number) => void;
}) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [lines, setLines] = useState<string[]>([]);
  const [log, setLog] = useState<LogEntry[]>(() => readLog(repoRoot, meta.feature));
  const [subAgent, setSubAgent] = useState<SubAgent | null>(() => computeActiveAgent(readLog(repoRoot, meta.feature)));
  const [subLines, setSubLines] = useState<string[]>([]);
  const [done, setDone] = useState<{ code: number; rejected?: boolean } | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [planPreview, setPlanPreview] = useState("");
  // Starts at the top of the plan (not the tail) every time a fresh plan is
  // shown, since the top is where the summary/overview lives.
  const [planScroll, setPlanScroll] = useState(0);
  const [planHtmlPath, setPlanHtmlPath] = useState("");
  const [finalHtmlPath, setFinalHtmlPath] = useState("");
  // Result of the commit pmctl makes once the PO approves the last gate.
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  // Which hand-off the run is parked at, null while it's moving. Drives
  // what the approval screen says and which phase approving it starts.
  const [activeGate, setActiveGate] = useState<Gate | null>(null);
  // Which stage the running PM invocation was spawned to do, and when.
  // The checklist can't answer this: it's derived from the log, so between
  // "PO approves the Dev gate" and "PM writes reviewer_started" it still
  // points at the finished stage, making a booting PM look like a stalled
  // one. This is the TUI saying what it actually dispatched.
  const [runningPhase, setRunningPhase] = useState<{ phase: PmPhase; startedAt: number } | null>(null);
  // The artifact from the gate most recently approved. Kept so pressing y
  // doesn't make the document vanish with no way back to it — the run
  // carries on in the live view, but what you just approved is still one
  // keypress away.
  const [lastArtifact, setLastArtifact] = useState<{ label: string; path: string } | null>(null);
  // Lines in log.ndjson that aren't readable JSON. Shown rather than
  // swallowed: a skipped line is a stage whose milestone the checklist and
  // the gate machinery can no longer see, so the PO needs to know the
  // history they're looking at has holes in it.
  const [skippedLogLines, setSkippedLogLines] = useState(0);
  // Usage/cost for the sub-agent currently in view, and the prompt size
  // pmctl handed the running PM invocation.
  const [subStats, setSubStats] = useState<SessionStats | null>(null);
  const [pmPromptTokens, setPmPromptTokens] = useState(0);
  // Free-text answers to a "คำถามถึง PO" section PM wrote into plan.md (see
  // src/planHtml.ts's hasOpenQuestions). Typed in-place on this same screen
  // ("a" key) rather than requiring the PO to edit plan.md by hand, then
  // written to answers.md for the post-approval PM invocation to read (see
  // buildInitialPrompt's continueAfterApproval branch in src/agents.ts).
  /**
   * The full-screen text box, and what the typed text is for. Three
   * moments in a run need the PO to write rather than press a key:
   * "brief" before anything starts (what PM should know that the ClickUp
   * ticket doesn't say), "answer" at a gate (replying to PM's open
   * questions), and "message" at any point at all — the PO noticing
   * something mid-stage and wanting to say so without waiting for the
   * next gate to come around. Same box, same keys, different destination.
   */
  const [textEntry, setTextEntry] = useState<"brief" | "answer" | "message" | null>(null);
  const [entryText, setEntryText] = useState("");
  // How many messages the PO has sent this session, so the panel can show
  // that they landed somewhere. Seeded from the file so a resumed run
  // doesn't claim the earlier ones never happened.
  const [messageCount, setMessageCount] = useState<number>(() => countPoMessages(repoRoot, meta.feature));
  // Scrollback position in the PM transcript: null means "live" (pinned to
  // the newest output, the original behaviour), a number is the index of the
  // first visible wrapped line. The panel kept MAX_LINES of history all
  // along but only ever showed the tail, so anything that scrolled past —
  // what Dev actually reported twenty minutes ago — was only recoverable by
  // opening the session log in another window.
  const [pmScroll, setPmScroll] = useState<number | null>(null);
  // Layout numbers the key handler needs for clamping, published from the
  // render below. They can't be closed over directly: the approval and
  // answer views return before the main layout is computed.
  const pmMaxScrollRef = useRef(0);
  const pmVisibleRowsRef = useRef(1);
  const childRef = useRef<ChildProcessByStdio<null, Readable, Readable> | null>(null);
  const tailRef = useRef(""); // carries a partial last line between chunks
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Which phase the currently-running PM invocation is, and whether the
  // approval screen has already been shown for it — both read by the log
  // poll below so it can react to `plan_awaiting_approval` the instant it
  // appears, without waiting on the child process's own "close" event.
  const currentPhaseRef = useRef<PmPhase | null>(null);
  // Whether the gate for the invocation now running has already been opened
  // — reset by startPhase, so each stage gets exactly one gate even though
  // the step that opens it stays in the log forever.
  const gateShownRef = useRef(false);
  /**
   * How many log entries existed when the invocation now running started.
   * A gate only counts if the entry that opens it is newer than this.
   *
   * Without it, approving a gate bounced straight back to the same gate:
   * the step that opened it (`plan_awaiting_approval`, say) stays in the
   * append-only log forever, and the freshly-spawned PM needs tens of
   * seconds to boot and log anything of its own — so the very next poll,
   * one second later, found that same step still sitting at the end of the
   * log, re-opened the gate, and killed the PM it had just started. The
   * run could never get past its first stage. (A stub that logged
   * instantly closed this window, which is exactly why the pty tests
   * didn't catch it — they now pause before logging, like the real CLI.)
   */
  const gateWatermarkRef = useRef(0);
  /** Whether this invocation's output has mentioned permissions at all. */
  const permissionSmellRef = useRef(false);
  // One notification per state change, not one per poll tick — the log line
  // that triggered it stays in the log forever, so without this the PO would
  // get a bell every second for the rest of the run.
  const attentionNotifiedRef = useRef(false);

  function clearPendingRetry() {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }

  /**
   * Parks the run at a gate: builds that stage's HTML artifact next to its
   * markdown source, best-effort opens it in the browser, notifies, and
   * switches the TUI into the full-screen review-and-approve view.
   *
   * Every hand-off in the chain comes through here — plan, Dev's summary,
   * the code review, the test report, and a failed iteration — so the PO
   * reads the same shape of page and presses the same keys at each, rather
   * than approving a plan once and then being shown nothing until the run
   * is over.
   *
   * The HTML is a convenience, never the source of truth: with no GUI, no
   * browser, or no opener binary, nothing opens and the terminal's own
   * scrollable view below carries the same content.
   */
  function showGate(gate: Gate, freshLog: LogEntry[]) {
    const markdown = readStageMarkdown(repoRoot, meta.feature, gate.source);
    setActiveGate(gate);
    setPlanPreview(markdown);
    setPlanScroll(0);

    const htmlPath = featureFile(repoRoot, meta.feature, gate.artifact);
    try {
      const html = buildStageHtml({
        feature: meta.feature,
        clickupRef,
        heading: gate.title,
        bodyHeading: STAGE_BODY_HEADING[gate.source],
        markdown,
        log: freshLog,
        generatedAt: new Date().toLocaleString("th-TH"),
        // Everything past the plan is a mid-run checkpoint, where "how did
        // we get here" is part of the decision.
        withTimeline: gate.source !== "plan",
        // From the Dev gate onward there is code to look at, and the diff
        // is what's actually being approved — the agent's write-up is
        // commentary on it. The plan gate has nothing to diff yet.
        diff: gate.source === "plan" ? null : collectRunDiff(meta.worktreePath, repoRoot, meta.feature),
        // Which agent's exchange belongs on this page follows from which
        // stage just finished.
        exchange: GATE_AGENT[gate.source]
          ? buildExchangeMarkdown(repoRoot, meta.feature, GATE_AGENT[gate.source]!)
          : "",
      });
      fs.writeFileSync(htmlPath, html, "utf8");
      setPlanHtmlPath(htmlPath);
      openInBrowser(htmlPath);
    } catch {
      // Best-effort only — the terminal view below never depends on this.
      setPlanHtmlPath("");
    }

    // Nothing moves until a human comes back — exactly the moment worth
    // interrupting them for.
    notify(
      `pmctl: ${meta.feature} — ${gate.title}`,
      hasOpenQuestions(markdown) ? `${gate.question} (มีคำถามถึง PO — กด a เพื่อตอบ)` : gate.question
    );
    setRunningPhase(null);
    setAwaitingApproval(true);
  }

  /**
   * The PO said yes at whichever gate is open: start the stage that gate
   * leads to. An `iteration` gate leads back to Dev rather than onward,
   * which is the whole reason the loop-back is a decision and not something
   * PM does by itself.
   */
  function approveGate() {
    const next = activeGate?.nextPhase ?? "dev";
    if (activeGate && planHtmlPath !== "") {
      setLastArtifact({ label: activeGate.title, path: planHtmlPath });
    }
    setAwaitingApproval(false);
    setLines([]); // fresh transcript for the next PM invocation
    startPhase(next);
  }

  function startPhase(phase: PmPhase, attempt: number = 1) {
    currentPhaseRef.current = phase;
    // A fresh invocation is past whichever gate opened it, so the gate
    // machinery starts listening again — but only for log entries written
    // from here on, never the one we just approved.
    gateShownRef.current = false;
    gateWatermarkRef.current = readLog(repoRoot, meta.feature).length;
    setActiveGate(null);
    setRunningPhase({ phase, startedAt: Date.now() });

    // Building the plan reads role templates and config off disk, so it
    // can fail for reasons that have nothing to do with the run: a role
    // file referencing a variable this build doesn't define (a pull
    // without a rebuild does exactly that), an unreadable file, a bad
    // setting. This used to throw straight out of a keypress handler and
    // kill the whole TUI — the same way one malformed log line used to —
    // taking the session down over something the PO could have fixed in
    // ten seconds. Show it and stay alive instead; the gate state is
    // untouched, so a re-run picks up exactly where this left off.
    let plan: PmSessionPlan;
    try {
      plan = buildPmSessionPlan(repoRoot, meta, permissionMode, clickupRef, phase);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRunningPhase(null);
      setLines((prev) =>
        prev.concat(
          "",
          `⚠ เริ่มขั้นตอน "${PHASE_LABEL[phase]}" ไม่สำเร็จ:`,
          ...splitLines(message),
          "",
          "งานที่ทำไปแล้วยังอยู่ครบ — แก้ตามข้อความข้างบนแล้วรัน pmctl run ใหม่ จะกลับมาที่ gate เดิม",
          "กด q หรือ Enter เพื่อออก"
        )
      );
      setDone({ code: 1 });
      return;
    }
    setPmPromptTokens(plan.promptTokens);
    plan.logFile.write(plan.notice);

    const child = spawnClaudeProcess(plan.args, plan.cwd);
    childRef.current = child;
    tailRef.current = "";
    let rawOutput = ""; // this invocation's own text only, to check for a transient-error pattern
    permissionSmellRef.current = false;

    const onChunk = (chunk: Buffer) => {
      plan.logFile.write(chunk);
      const asText = chunk.toString("utf8");
      rawOutput += asText;
      if (!permissionSmellRef.current && PERMISSION_PATTERNS.some((re) => re.test(asText))) {
        permissionSmellRef.current = true;
      }
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
      if (gateShownRef.current) {
        // The log poll below already saw this stage's gate step land and
        // killed this process on purpose — this "close" is that kill
        // arriving, not a real failure or a normal exit. Don't re-process
        // it as either (that would re-show the gate a second time, or show
        // it as "done"/retry a process we killed ourselves).
        return;
      }
      const exitCode = code ?? 0;

      if (exitCode !== 0 && isTransientError(rawOutput) && attempt < MAX_TRANSIENT_RETRIES) {
        const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        setLines((prev) =>
          prev.concat(
            "",
            `⏳ เจอ error ฝั่ง API ชั่วคราว (เช่น 529 overloaded) ไม่ใช่ปัญหาจาก plan/PM — จะลองใหม่อัตโนมัติใน ${Math.round(delayMs / 1000)} วิ (รอบ ${attempt + 1}/${MAX_TRANSIENT_RETRIES})`
          )
        );
        retryTimeoutRef.current = setTimeout(() => {
          retryTimeoutRef.current = null;
          startPhase(phase, attempt + 1);
        }, delayMs);
        return;
      }

      const freshLog = readLog(repoRoot, meta.feature);
      // PM exited on its own at the end of its stage (the normal case when
      // it obeys "stop now" rather than needing the poll below to kill it).
      // Same watermark rule as the poll: only a gate this invocation
      // actually reached counts, never the one it was started from.
      const parked = exitCode === 0 ? openGate(freshLog) : null;
      if (parked && parked.index >= gateWatermarkRef.current) {
        gateShownRef.current = true;
        showGate(parked.gate, freshLog);
        return;
      }
      if (exitCode === 0 && finalDoneIndex(freshLog) >= gateWatermarkRef.current) {
        finishRun(freshLog, exitCode);
        return;
      }
      if (exitCode === 0 && freshLog.length === gateWatermarkRef.current) {
        // Exited cleanly having logged nothing at all: its stage didn't
        // happen. Say so rather than reporting a successful finish, since
        // the checklist will still be sitting on the previous stage.
        setLines((prev) =>
          prev.concat(
            "",
            "⚠ PM จบรอบนี้โดยไม่ได้บันทึก log ของขั้นตอนเลย — ขั้นตอนนี้ยังไม่ได้ทำจริง รัน pmctl run ใหม่เพื่อลองอีกครั้ง"
          )
        );
      }
      // The run is over either way — if you walked away expecting to come
      // back to a finished feature, this is what tells you it's time.
      notify(
        `pmctl: ${meta.feature} ${exitCode === 0 ? "จบงานแล้ว" : "จบแบบมี error"}`,
        exitCode === 0
          ? "ทุกขั้นตอนเสร็จ — กลับมาดูผลและทดสอบ acceptance ได้"
          : `PM session จบด้วย exit code ${exitCode}`
      );
      setDone({ code: exitCode });
    });
  }

  /**
   * End of the line: builds report.html out of everything the chain
   * produced (plan, Dev's summary, the review, the test report, and the
   * full timeline) and opens it. A finished run used to leave the PO with
   * a scrolled-past terminal and a dot-directory — nothing to actually
   * read, keep, or send on.
   */
  function finishRun(freshLog: LogEntry[], exitCode: number) {
    setRunningPhase(null);

    // The PO approved the last gate, which is what authorises this. pmctl
    // commits rather than PM, so the commit is a mechanical step at a
    // known moment instead of an LLM composing git commands mid-run —
    // and so the PO gets to see what it would contain before approving.
    // Branches stay the PO's own business and nothing is pushed.
    // Must happen before the commit: once committed there is nothing left
    // in the working tree to diff against HEAD.
    const runDiff = collectRunDiff(meta.worktreePath, repoRoot, meta.feature);

    let commit: CommitResult | null = null;
    if (commitOnFinish && exitCode === 0) {
      const message = readCommitMessage(repoRoot, meta.feature, clickupRef);
      commit = commitWork(meta.worktreePath, repoRoot, meta.feature, message);
      setCommitResult(commit);
    }

    const htmlPath = featureFile(repoRoot, meta.feature, "finalHtml");
    let built = false;
    try {
      const html = buildFinalReportHtml({
        feature: meta.feature,
        clickupRef,
        port: meta.port,
        sections: [
          { heading: "แผนงาน (plan.md)", markdown: readStageMarkdown(repoRoot, meta.feature, "plan") },
          { heading: "สรุปงานจาก Dev", markdown: readStageMarkdown(repoRoot, meta.feature, "devSummary") },
          { heading: "ผลตรวจโค้ดจาก Reviewer", markdown: readStageMarkdown(repoRoot, meta.feature, "review") },
          { heading: "ผลทดสอบจาก Tester", markdown: readStageMarkdown(repoRoot, meta.feature, "report") },
          { heading: "ข้อสั่งการจาก PO ก่อนเริ่มงาน", markdown: readOptionalFile(repoRoot, meta.feature, "poBrief") },
          { heading: "ข้อความจาก PO ระหว่างทาง", markdown: readOptionalFile(repoRoot, meta.feature, "poMessages") },
          { heading: "ต้นทุนและ context ของแต่ละ session", markdown: buildStatsMarkdown(repoRoot, meta.feature) },
          { heading: "Commit", markdown: describeCommitMarkdown(commit, commitOnFinish) },
          {
            heading: "บทสนทนา PM ↔ agent ทั้งหมด",
            markdown: (["dev", "reviewer", "tester"] as SubAgent[])
              .map((a) => {
                const ex = buildExchangeMarkdown(repoRoot, meta.feature, a);
                return ex ? `## ${a}\n\n${ex}` : "";
              })
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        log: freshLog,
        generatedAt: new Date().toLocaleString("th-TH"),
        // Collected before the commit below runs, while the changes are
        // still uncommitted and therefore still a diff against HEAD.
        diff: runDiff,
      });
      fs.writeFileSync(htmlPath, html, "utf8");
      setFinalHtmlPath(htmlPath);
      openInBrowser(htmlPath);
      built = true;
    } catch {
      setFinalHtmlPath("");
    }
    notify(
      `pmctl: ${meta.feature} จบงานแล้ว`,
      built ? "เปิดรายงานสรุป report.html ให้แล้ว — เหลือ PO ทดสอบ acceptance เอง" : "ทุกขั้นตอนเสร็จแล้ว"
    );
    setDone({ code: exitCode });
  }

  useEffect(() => {
    // Snapshot what was already dirty before this run touches anything,
    // so the commit at the end can tell this run's work apart from the
    // PO's own in-progress edits. No-ops on a resumed run.
    if (commitOnFinish) recordGitBaseline(repoRoot, meta.feature, meta.worktreePath);

    const resume = determineResumePhase(repoRoot, meta.feature);
    const resumeLog = readLog(repoRoot, meta.feature);
    if (resume === "gateResume") {
      const parked = openGate(resumeLog)!;
      gateShownRef.current = true;
      showGate(parked.gate, resumeLog);
    } else if (resume === "alreadyDone") {
      // Nothing left to run — rebuild the report rather than re-dispatching
      // a finished pipeline.
      finishRun(resumeLog, 0);
    } else if (resume === "initial" && briefMode !== "skip") {
      // Fresh run: ask before anything is dispatched. This is the only
      // point where the PO can shape the work rather than react to it —
      // every other interaction is approving something already done.
      setEntryText(briefMode === "ask" ? "" : briefMode);
      setTextEntry("brief");
    } else {
      startPhase(resume);
    }

    return () => {
      clearPendingRetry();
      if (childRef.current && !childRef.current.killed) {
        childRef.current.kill();
      }
    };
    // Spawn exactly once per mount — meta/permissionMode/clickupRef don't change mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const { entries: freshLog, skipped } = readLogSafe(repoRoot, meta.feature);
      setLog(freshLog);
      setSkippedLogLines(skipped);
      const agent = computeActiveAgent(freshLog);
      setSubAgent(agent);
      setSubLines(readSubAgentLines(repoRoot, meta.feature, agent));
      setSubStats(readSubAgentStats(repoRoot, meta.feature, agent));

      // PM logs this when Dev/Reviewer/Tester hit a decision only the PO can
      // make (roles/pm.md's communication rules). The run keeps going, but
      // its final answer is a question — worth a nudge, not just a red line
      // on a panel nobody's looking at.
      if (!attentionNotifiedRef.current && freshLog.some((e) => e.step === "needs_po_attention")) {
        attentionNotifiedRef.current = true;
        const entry = [...freshLog].reverse().find((e) => e.step === "needs_po_attention");
        notify(`pmctl: ${meta.feature} ต้องการให้ PO ตัดสินใจ`, entry?.reason ?? "ดูคำตอบสุดท้ายของ PM");
      }

      // PM is instructed (roles/pm.md) to log its stage's step and stop
      // immediately — but a real run showed it sometimes keeps going past
      // that point (more bash tool calls, more reasoning, and at worst
      // dispatching the *next* agent, which is exactly the hand-off the PO
      // is supposed to approve) instead of actually exiting. Waiting for
      // the process to close on its own left the TUI sitting on a stale
      // checklist looking stuck while the thing the PO was waiting on was
      // already written. React the instant the log line appears: kill the
      // still-running invocation — it has nothing left it should be doing —
      // and open the gate now. This is also what stops a disobedient PM
      // from running the whole chain in one go.
      if (!gateShownRef.current && currentPhaseRef.current !== "fullRunNoGate") {
        const parked = openGate(freshLog);
        const finalAt = finalDoneIndex(freshLog);
        const stopHere = () => {
          gateShownRef.current = true;
          clearPendingRetry();
          if (childRef.current && !childRef.current.killed) {
            childRef.current.kill();
          }
        };
        if (parked && parked.index >= gateWatermarkRef.current) {
          stopHere();
          showGate(parked.gate, freshLog);
        } else if (finalAt >= gateWatermarkRef.current) {
          stopHere();
          finishRun(freshLog, 0);
        }
      }
    }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [repoRoot, meta.feature]);

  // Full-screen plan view: the whole terminal width/height (minus the header
  // line and this panel's own border+instructions+scroll-indicator rows),
  // not the cramped one-third-of-screen side panel the approval prompt used
  // to share with the PM transcript. That old layout only ever showed the
  // *tail* of plan.md — which, for anything longer than a screen, hid the
  // summary at the top entirely. This view starts at the top and scrolls.
  const planWidth = Math.max(40, columns - 2);
  const planPanelHeight = Math.max(5, rows - HEADER_ROWS);
  const planVisibleRows = Math.max(1, planPanelHeight - PANEL_CHROME_ROWS - 3);
  const planLines = awaitingApproval ? renderPlanLines(planPreview, planWidth - PANEL_INNER_PADDING) : [];
  const planMaxScroll = Math.max(0, planLines.length - planVisibleRows);

  useInput((input, key) => {
    if (textEntry) {
      if (key.ctrl && input === "c") {
        if (textEntry === "answer" || textEntry === "message") {
          // Cancel just the box, not the whole run — easy to fat-finger
          // mid-typing, and nothing is written until Esc anyway.
          setTextEntry(null);
          setEntryText("");
        } else {
          // At the brief there is no run yet to go back to, so Ctrl+C
          // means what it means everywhere else: quit.
          setTextEntry(null);
          onDone(130);
          exit();
        }
        return;
      }
      if (key.escape) {
        const trimmed = entryText.trim();
        const kind = textEntry;
        if (trimmed) {
          try {
            if (kind === "message") {
              // Appended, not overwritten: this is a running thread the PO
              // adds to, and PM re-reads all of it at every stage.
              fs.appendFileSync(
                featureFile(repoRoot, meta.feature, "poMessages"),
                `\n## ${new Date().toLocaleString("th-TH")}\n${trimmed}\n`,
                "utf8"
              );
              setMessageCount((n) => n + 1);
            } else {
              fs.writeFileSync(
                featureFile(repoRoot, meta.feature, kind === "brief" ? "poBrief" : "answers"),
                trimmed + "\n",
                "utf8"
              );
            }
          } catch {
            // Best-effort — if this fails PM just proceeds without it,
            // same as if the PO had typed nothing.
          }
        }
        setTextEntry(null);
        setEntryText("");
        // Empty text is a deliberate "nothing to add", not a cancel: the
        // brief and answer paths continue either way, just with no file.
        // A message never advances anything — the run carries on exactly
        // where it was, which is the point of being able to send one at
        // any time.
        if (kind === "brief") startPhase("initial");
        else if (kind === "answer") approveGate();
        return;
      }
      if (key.return) {
        setEntryText((t) => t + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        setEntryText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setEntryText((t) => t + input);
      }
      return;
    }
    if (key.ctrl && input === "c") {
      clearPendingRetry();
      childRef.current?.kill();
      onDone(130);
      exit();
      return;
    }
    if (awaitingApproval) {
      if (input === "a") {
        setEntryText("");
        setTextEntry("answer");
      } else if (input === "m") {
        setEntryText("");
        setTextEntry("message");
      } else if (input === "y" || key.return) {
        approveGate();
      } else if (input === "n") {
        setAwaitingApproval(false);
        setDone({ code: 2, rejected: true });
      } else if (key.downArrow || input === "j") {
        setPlanScroll((s) => Math.min(planMaxScroll, s + 1));
      } else if (key.upArrow || input === "k") {
        setPlanScroll((s) => Math.max(0, s - 1));
      } else if (input === "f" || input === " ") {
        setPlanScroll((s) => Math.min(planMaxScroll, s + planVisibleRows));
      } else if (input === "b") {
        setPlanScroll((s) => Math.max(0, s - planVisibleRows));
      } else if (input === "g") {
        setPlanScroll(0);
      } else if (input === "G") {
        setPlanScroll(planMaxScroll);
      }
      return;
    }
    // Scrollback over the PM transcript, on saaio's keys so the muscle
    // memory carries over: `[` enters, q/Esc returns to live, k/j by line,
    // Ctrl-U/Ctrl-D by half a screen, Ctrl-B/Ctrl-F by a full screen, g/G
    // for the ends. Output keeps streaming in behind the scrolled view
    // rather than yanking it back to the bottom — the whole point is to
    // read something while the run carries on.
    const page = pmVisibleRowsRef.current;
    const maxScroll = pmMaxScrollRef.current;
    if (pmScroll !== null) {
      const at = Math.min(pmScroll, maxScroll);
      if (input === "q" || key.escape) setPmScroll(null);
      else if (input === "k" || key.upArrow) setPmScroll(Math.max(0, at - 1));
      else if (input === "j" || key.downArrow) setPmScroll(Math.min(maxScroll, at + 1));
      else if (key.ctrl && input === "u") setPmScroll(Math.max(0, at - Math.floor(page / 2)));
      else if (key.ctrl && input === "d") setPmScroll(Math.min(maxScroll, at + Math.floor(page / 2)));
      else if (key.ctrl && input === "b") setPmScroll(Math.max(0, at - page));
      else if (key.ctrl && input === "f") setPmScroll(Math.min(maxScroll, at + page));
      else if (input === "g") setPmScroll(0);
      else if (input === "G") setPmScroll(null); // the bottom *is* live
      return;
    }
    if (input === "m") {
      setEntryText("");
      setTextEntry("message");
      return;
    }
    if (input === "v" && lastArtifact) {
      openInBrowser(lastArtifact.path);
      return;
    }
    if (input === "[") {
      // Start where the live view already was, so entering scrollback never
      // jumps the text you were reading.
      setPmScroll(maxScroll);
      return;
    }
    if (done && (input === "q" || key.return)) {
      onDone(done.code);
      exit();
    }
  });

  if (textEntry) {
    const entryLines = entryText.length === 0 ? [""] : entryText.split("\n");
    const isBrief = textEntry === "brief";
    const isMessage = textEntry === "message";
    // When PM will actually see it. Nothing here can reach a process
    // already running — PM and its sub-agents are all headless `claude -p`
    // with no stdin to interrupt — so this says when PM next gets control,
    // which is the difference between a queue and a chat box that quietly
    // does nothing. PM re-reads the thread as soon as a sub-agent returns,
    // so mid-stage usually means sooner than the next gate.
    const deliveryNote = runningPhase
      ? `ตอนนี้กำลังรัน "${PHASE_LABEL[runningPhase.phase]}" อยู่ — แทรกกลางคันไม่ได้ PM จะอ่านทันทีที่ได้ควบคุมกลับ (agent ที่รันอยู่ตอบกลับ หรือเริ่มขั้นตอนถัดไป)`
      : awaitingApproval
        ? "PM จะอ่านทันทีที่คุณกด y อนุมัติให้ทำขั้นตอนต่อไป"
        : "PM จะอ่านตอนเริ่มขั้นตอนถัดไป";
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box>
          <Text bold>pmctl run — {meta.feature}</Text>
          <Text dimColor>
            {" "}
            — {isMessage ? "พิมพ์บอก PM" : isBrief ? "บอก PM ก่อนเริ่มงาน" : "พิมพ์คำตอบให้ PM ก่อนอนุมัติ"}
          </Text>
        </Box>
        <Box
          marginTop={1}
          height={Math.max(5, rows - HEADER_ROWS)}
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
        >
          {isMessage ? (
            <>
              <Text bold color="yellow">
                พิมพ์บอก PM (ส่งได้ตลอดเวลา ไม่กระทบขั้นตอนที่กำลังรันอยู่)
              </Text>
              <Text color="cyan">{deliveryNote}</Text>
              <Text dimColor>
                ส่งถึง PM เท่านั้น (Dev/Reviewer/Tester ไม่เห็น) ทุกข้อความเก็บสะสมไว้และ PM อ่านใหม่ทุกครั้งที่ได้ควบคุมกลับ
                ถือเป็นคำสั่งที่ยังมีผลอยู่ ไม่ใช่อ่านครั้งเดียวทิ้ง — ถ้าขัดกับข้อความเก่า อันใหม่ชนะ
              </Text>
              <Text dimColor>
                PM เป็นคนตัดสินใจเองว่าจะปล่อยให้ agent ที่รันอยู่ทำจนจบ ทิ้งงานแล้วสั่งใหม่ หรือหยุดมาถามคุณ — pmctl
                ไม่ไปหยุดอะไรให้เอง
              </Text>
              <Text dimColor>Enter ขึ้นบรรทัดใหม่ · Esc ส่ง · Ctrl+C ยกเลิก</Text>
            </>
          ) : isBrief ? (
            <>
              <Text bold color="yellow">
                มีอะไรอยากบอก PM ก่อนเริ่มไหม? (ไม่มีก็กด Esc ข้ามได้เลย)
              </Text>
              <Text dimColor>
                เช่น ขอบเขตที่ห้ามเกิน, ไฟล์ที่ห้ามแตะ, แนวทางที่ลูกค้าเคยปฏิเสธมาแล้ว, อะไรที่ไม่ได้เขียนไว้ใน ClickUp ticket —
                PM จะอ่านอันนี้ก่อนวางแผน และต้องสะท้อนลงใน plan.md ให้เห็นว่าเอาไปใช้ยังไง
              </Text>
              <Text dimColor>Enter ขึ้นบรรทัดใหม่ · Esc บันทึกแล้วเริ่มงาน · Ctrl+C ออก (ยังไม่เริ่มอะไรทั้งนั้น)</Text>
            </>
          ) : (
            <Text bold color="yellow">
              พิมพ์คำตอบคำถามที่ PM ถามไว้ (ดูหัวข้อ "คำถามถึง PO" ในเอกสาร) · Enter ขึ้นบรรทัดใหม่ · Esc บันทึกคำตอบ +
              อนุมัติให้ทำต่อ · Ctrl+C ยกเลิกการพิมพ์ (กลับไปอ่านเอกสาร)
            </Text>
          )}
          <Box marginTop={1} flexDirection="column">
            {entryLines.map((l, i) => (
              <Text key={i}>{l || " "}</Text>
            ))}
          </Box>
          <Text dimColor>█</Text>
        </Box>
      </Box>
    );
  }

  if (awaitingApproval) {
    const visiblePlan = planLines.slice(planScroll, planScroll + planVisibleRows);
    const atTop = planScroll === 0;
    const atBottom = planScroll >= planMaxScroll;
    const hasQuestions = hasOpenQuestions(planPreview);
    const pmPassedThrough = hasUnresolvedAgentQuestions(planPreview);
    // Read at render time rather than cached: the PO may have edited files
    // themselves while reading the gate, and what gets committed should be
    // what's actually there when they approve.
    const pending =
      activeGate?.nextPhase === "final"
        ? listPendingChanges(meta.worktreePath, repoRoot, meta.feature)
        : { files: [], preExisting: [] };
    const pendingFiles = pending.files;
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box>
          <Text bold>pmctl run — {meta.feature}</Text>
          <Text dimColor>
            {" "}
            (branch={meta.branch}) — {activeGate?.title ?? "รออนุมัติ"}
          </Text>
        </Box>
        <Box
          marginTop={1}
          height={planPanelHeight}
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
        >
          <Text bold color="yellow">
            {activeGate?.question ?? "อนุมัติให้ทำต่อไหม"} — y/Enter อนุมัติ · a พิมพ์คำตอบให้ PM ก่อนอนุมัติ · m พิมพ์บอก PM
            เฉยๆ · n หยุดไว้ก่อน
          </Text>
          <Text dimColor>
            ↑/↓ หรือ j/k เลื่อน · space/f หน้าถัดไป · b หน้าก่อนหน้า · g/G บนสุด/ล่างสุด
          </Text>
          {hasQuestions && (
            <Text bold color="red">
              ⚠ มีคำถามถึง PO อยู่ในเอกสารนี้ — กด a เพื่อพิมพ์คำตอบก่อนอนุมัติ
            </Text>
          )}
          {activeGate?.nextPhase === "final" && commitOnFinish && (
            // The last gate is the one that also authorises the commit, so
            // it has to say so before the PO presses y — not afterwards.
            <Box flexDirection="column">
              <Text color="green">
                เมื่ออนุมัติ: PM สรุปปิดงาน แล้ว pmctl จะ commit ให้ {pendingFiles.length} ไฟล์ (ไม่รวม .pmctl/ และไม่ push)
              </Text>
              {pendingFiles.slice(0, 5).map((f) => (
                <Text key={f} dimColor>
                  {"  "}
                  {f}
                </Text>
              ))}
              {pendingFiles.length > 5 && <Text dimColor>{"  "}… อีก {pendingFiles.length - 5} ไฟล์</Text>}
              {pendingFiles.length === 0 && <Text dimColor>{"  "}(ไม่มีไฟล์ที่เปลี่ยนจากรอบนี้ — จะไม่ commit อะไร)</Text>}
              {pending.preExisting.length > 0 && (
                <Text color="yellow">
                  ข้าม {pending.preExisting.length} ไฟล์ที่มีการแก้ค้างอยู่ก่อนเริ่มรัน — ไม่ commit ให้ ({
                    pending.preExisting.slice(0, 3).join(", ")
                  }
                  {pending.preExisting.length > 3 ? ", …" : ""}) จัดการเองนะ
                </Text>
              )}
            </Box>
          )}
          {pmPassedThrough && (
            <Text bold color="yellow">
              ⚠ ยังมีหัวข้อ "คำถามถึง PM" ค้างอยู่ — PM ควรตอบเองหรือกรองออกก่อนส่งมาถึงคุณ
            </Text>
          )}
          {planHtmlPath ? (
            <Text dimColor>
              เปิดฉบับเต็ม + flow chart ในเบราว์เซอร์ให้แล้ว: file://{planHtmlPath}
            </Text>
          ) : (
            <Text dimColor color="red">
              สร้าง/เปิดไฟล์ HTML ไม่สำเร็จ — อ่านจากที่เลื่อนได้ด้านล่างแทน
            </Text>
          )}
          <Text dimColor>
            บรรทัด {planLines.length === 0 ? 0 : planScroll + 1}-{Math.min(planLines.length, planScroll + planVisibleRows)} จาก{" "}
            {planLines.length}
            {atTop ? "" : " ↑มีต่อด้านบน"}
            {atBottom ? "" : " ↓มีต่อด้านล่าง"}
          </Text>
          {visiblePlan.map((l, i) => (
            <Text key={i} bold={l.heading} color={l.heading ? "cyan" : undefined} wrap="truncate-end">
              {l.text || " "}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  // Fill the real terminal: compute panel widths/heights from the current
  // columns/rows instead of hardcoding them, and recompute whenever the
  // terminal is resized (useTerminalSize above).
  const checklistWidth = Math.max(MIN_CHECKLIST_WIDTH, Math.floor(columns * CHECKLIST_WIDTH_RATIO));
  // Three side-by-side panels need real width to stay readable; below this,
  // an 80-col terminal (a common default) would overflow. Below the
  // threshold, fall back to the original two-panel layout — checklist + PM
  // session only — rather than cramming a third panel no one can read.
  const showSubPanel = columns >= 100;
  let pmWidth: number;
  let subWidth: number;
  if (showSubPanel) {
    const remainingWidth = columns - checklistWidth - 4; // 4 = two 1-col gaps between three panels
    pmWidth = Math.max(MIN_SIDE_PANEL_WIDTH, Math.ceil(remainingWidth / 2));
    subWidth = Math.max(MIN_SIDE_PANEL_WIDTH, remainingWidth - pmWidth);
  } else {
    pmWidth = Math.max(40, columns - checklistWidth - 3); // 3 = gap + borders between two panels
    subWidth = 0;
  }
  // Narrow-terminal fallback prints one extra hint line below the panels,
  // so reserve a row for it or the layout would overflow the real terminal.
  const panelHeight = Math.max(5, rows - HEADER_ROWS - (showSubPanel ? 0 : 1));
  const visibleRows = Math.max(1, panelHeight - PANEL_CHROME_ROWS - (done ? 1 : 0));

  const checklist = computeChecklist(log);
  const subPanelTitle = subAgent ? AGENT_PANEL_TITLE[subAgent] : "SUB-AGENT (ยังไม่เริ่ม)";
  // The brief PM logged when it dispatched this agent. PM composes the real
  // prompt inside its own bash call, which pmctl never sees — but it is
  // required to log what it dispatched, and that line is written through
  // `pmctl log-append` now, so it arrives intact.
  const subPrompt = subAgent ? readAgentPrompt(repoRoot, meta.feature, subAgent) : null;
  const subBrief = subPrompt ?? (subAgent ? briefForAgent(log, subAgent) : null);
  const subContextHeavy =
    subStats?.contextTokens !== undefined && subStats.contextTokens > ASSUMED_CONTEXT_WINDOW * 0.75;

  // PM transcript, wrapped once and then either tailed (live) or windowed
  // (scrollback). The clamps are published to refs for the key handler,
  // which runs outside this render path.
  const pmWrapped = wrapLines(lines, pmWidth - PANEL_INNER_PADDING);
  const pmMaxScroll = Math.max(0, pmWrapped.length - visibleRows);
  pmMaxScrollRef.current = pmMaxScroll;
  pmVisibleRowsRef.current = visibleRows;
  const pmFirstVisible = pmScroll === null ? Math.max(0, pmWrapped.length - visibleRows) : Math.min(pmScroll, pmMaxScroll);
  const pmVisible = pmWrapped.slice(pmFirstVisible, pmFirstVisible + visibleRows);
  const footerHint = done
    ? ", q/Enter ออก, m พิมพ์บอก PM"
    : lastArtifact
      ? ", m พิมพ์บอก PM, [ เลื่อนดูย้อนหลัง, v เปิดเอกสารที่เพิ่งอนุมัติ"
      : ", m พิมพ์บอก PM, [ เลื่อนดูย้อนหลัง";
  // Recomputed on every render, and the log poll re-renders once a second,
  // so these tick on their own without a second timer.
  const runAge = checklist.startedAt ? formatAge(checklist.startedAt) : null;
  const currentAge = checklist.currentSince ? formatAge(checklist.currentSince) : null;
  // The step that's been sitting still long enough to be worth a second
  // look. Not an error — plenty of legitimate steps (a big Dev change, a
  // full e2e run) take longer than this — just the point where "is it stuck
  // or is it working?" becomes a fair question, so the number turns red
  // rather than staying quietly dim.
  // Has the running invocation written any log line of its own yet? Uses
  // the same watermark the gate machinery does, so "PM hasn't started" and
  // "PM is working" are distinguished by evidence rather than elapsed time.
  const loggedSincePhaseStart = runningPhase !== null && log.length > gateWatermarkRef.current;
  const phaseLooksStuck =
    runningPhase !== null &&
    !done &&
    !loggedSincePhaseStart &&
    Date.now() - runningPhase.startedAt > PHASE_SILENT_HINT_MS;
  const currentIsSlow =
    checklist.currentSince !== null &&
    Date.now() - new Date(checklist.currentSince).getTime() > SLOW_STEP_MS &&
    !done;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text bold>pmctl run — {meta.feature}</Text>
        <Text dimColor>
          {" "}
          (branch={meta.branch}){runAge ? ` — รันมาแล้ว ${runAge}` : ""} — Ctrl+C ยกเลิก{footerHint}
        </Text>
      </Box>
      <Box marginTop={1} height={panelHeight}>
        <Box flexDirection="column" width={checklistWidth} height={panelHeight} borderStyle="single" paddingX={1}>
          <Text bold dimColor>
            TODO (PM → Dev → Tester)
          </Text>
          {checklist.items.map((item) => {
            const stuck = item.status === "current" && checklist.needsAttention;
            // Only the in-flight step carries an age: a "done" step's own
            // duration is history the log already has, and showing ten of
            // them turns the checklist into a table nobody reads.
            const age = item.status === "current" && currentAge ? ` ${currentAge}` : "";
            return (
              <Text key={item.id} color={stuck ? "red" : checklistColor(item.status)} bold={item.status === "current"}>
                {stuck ? "⚠" : checklistMark(item.status)} {item.label}
                {age ? <Text color={currentIsSlow ? "red" : "gray"}>{age}</Text> : ""}
              </Text>
            );
          })}
          {skippedLogLines > 0 && (
            <Text bold color="red">
              ⚠ log เสียหาย {skippedLogLines} บรรทัด (อ่านเป็น JSON ไม่ได้ ข้ามไป) — checklist อาจไม่ตรงกับงานจริง
            </Text>
          )}
          {checklist.iterationCount > 0 && (
            <Text color="yellow">↻ วนแก้แล้ว {checklist.iterationCount} รอบ</Text>
          )}
          {checklist.needsAttention && (
            <Text bold color="red">
              ⚠ ต้องการให้ PO ตัดสินใจ — ดูคำตอบสุดท้ายของ PM
            </Text>
          )}
          {runningPhase && !done && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="cyan">
                ▶ กำลังรัน: {PHASE_LABEL[runningPhase.phase]}
              </Text>
              <Text dimColor>
                {loggedSincePhaseStart
                  ? "PM กำลังทำงานอยู่ (ดูช่องขวา)"
                  : `รอ PM เริ่มบันทึก log — ${formatAge(new Date(runningPhase.startedAt).toISOString())}`}
              </Text>
            </Box>
          )}
          {phaseLooksStuck && (
            // The two reasons a stage goes quiet look identical from here,
            // so name both rather than guessing: one is fine and one needs
            // the PO to restart the run differently.
            <Box marginTop={1} flexDirection="column">
              <Text bold color="red">
                ⚠ ยังไม่มี log ของขั้นตอนนี้นาน {formatAge(new Date(runningPhase!.startedAt).toISOString())}
              </Text>
              <Text color="red">
                {permissionSmellRef.current
                  ? "ในเอาต์พุตมีเรื่อง permission — เป็นไปได้สูงว่าค้างรอ approval ของ Bash tool ที่ตอบไม่ได้ในโหมด headless"
                  : "อาจกำลังคิดอยู่จริงๆ หรือค้างรอ approval ของ tool ที่ตอบไม่ได้ในโหมด headless"}
              </Text>
              <Text dimColor>
                ถ้าค้าง: Ctrl+C แล้วรันใหม่ด้วย --permission-mode bypassPermissions (กลับมาที่ gate เดิม ไม่เสียงานที่ทำไปแล้ว)
              </Text>
            </Box>
          )}
          {messageCount > 0 && (
            <Text color="cyan">✉ ส่งข้อความถึง PM แล้ว {messageCount} ข้อความ (PM อ่านใหม่ทุกต้นขั้นตอน)</Text>
          )}
          {lastArtifact && !awaitingApproval && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>อนุมัติล่าสุด: {lastArtifact.label}</Text>
              <Text dimColor>กด v เปิดอ่านซ้ำในเบราว์เซอร์</Text>
            </Box>
          )}
          {checklist.latest && (
            // What's actually happening right now, in the agent's own words
            // (every milestone in roles/pm.md carries a `reason`). A ticked
            // box says which stage we're at; this says what's going on
            // inside it — the difference between "working" and "stuck".
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>ล่าสุด ({checklist.latest.actor}):</Text>
              {wrapLine(checklist.latest.reason, Math.max(10, checklistWidth - PANEL_INNER_PADDING))
                .slice(0, 4)
                .map((l, i) => (
                  <Text key={i} dimColor wrap="truncate-end">
                    {l}
                  </Text>
                ))}
            </Box>
          )}
        </Box>

        <Box
          flexDirection="column"
          width={pmWidth}
          height={panelHeight}
          borderStyle="single"
          paddingX={1}
          marginLeft={1}
        >
          {pmScroll === null ? (
            <Text bold dimColor>
              PM SESSION (live)
            </Text>
          ) : (
            <Text bold color="cyan">
              PM SESSION (ย้อนหลัง {pmFirstVisible + 1}-{Math.min(pmWrapped.length, pmFirstVisible + visibleRows)} จาก{" "}
              {pmWrapped.length} · q/Esc กลับ live)
            </Text>
          )}
          {pmPromptTokens > 0 && (
            // PM runs in plain-text print mode, which reports no usage at
            // all — so rather than an empty meter, this states the part
            // that is actually known: the prompt pmctl itself composed.
            // Everything PM reads afterwards (spec, plan, sub-agent
            // replies) adds to this and can't be counted from here.
            <Text dimColor>
              context เริ่มต้น ~{formatEstimatedTokens(pmPromptTokens)} tokens (prompt + system prompt ที่ pmctl ส่งให้ —
              ประมาณการ ยังไม่รวมไฟล์ที่ PM อ่านเองระหว่างทาง)
            </Text>
          )}
          {lines.length === 0 && !done && <Text dimColor>(กำลังเริ่ม...)</Text>}
          {pmVisible.map((l, i) => (
            <Text key={i} wrap="truncate-end">
              {l}
            </Text>
          ))}
          {done && !done.rejected && (
            <Text bold color={done.code === 0 ? "green" : "red"}>
              -- จบแล้ว (exit code {done.code}) --
            </Text>
          )}
          {done && !done.rejected && finalHtmlPath !== "" && (
            <Text color="green">รายงานสรุป: file://{finalHtmlPath}</Text>
          )}
          {done && commitResult?.ok && (
            <Text color="green">
              commit แล้ว: {commitResult.hash} ({commitResult.files.length} ไฟล์) — ยังไม่ push ให้นะ push เองเมื่อพร้อม
            </Text>
          )}
          {done && commitResult && !commitResult.ok && (
            <Text color="red">commit ไม่สำเร็จ: {commitResult.error?.split("\n")[0]} — งานยังอยู่ครบใน working tree</Text>
          )}
          {done && done.rejected && (
            <Text bold color="red">
              -- หยุดไว้ที่ขั้นตอนนี้ — แก้ไฟล์ของขั้นตอนนั้นเองแล้วรัน pmctl run ใหม่ จะกลับมาถามที่เดิม --
            </Text>
          )}
        </Box>

        {showSubPanel && (
          <Box
            flexDirection="column"
            width={subWidth}
            height={panelHeight}
            borderStyle="single"
            paddingX={1}
            marginLeft={1}
          >
            <Text bold dimColor>
              {subPanelTitle}
            </Text>
            {subStats && (
              <Text color={subContextHeavy ? "red" : "gray"}>
                {formatSessionStats(subStats)}
                {subStats.isError ? " · จบแบบ error" : ""}
              </Text>
            )}
            {subAgent && !subStats && <Text dimColor>context/สถิติ: ได้หลัง agent จบรอบ (--output-format json)</Text>}
            {subBrief && (
              // What PM actually asked this agent to do. Without it the
              // panel is a wall of reply text with no statement of the
              // task it's replying to.
              <Box flexDirection="column">
                <Text dimColor>{subPrompt ? "PM สั่งว่า (prompt จริง):" : "โจทย์ (สรุปจาก log — PM ยังไม่ได้บันทึก prompt):"}</Text>
                {wrapLine(subBrief, Math.max(10, subWidth - PANEL_INNER_PADDING))
                  .slice(0, 3)
                  .map((l, i) => (
                    <Text key={i} color="cyan" wrap="truncate-end">
                      {l}
                    </Text>
                  ))}
              </Box>
            )}
            {!subAgent && <Text dimColor>(PM ยังไม่ได้สั่ง Dev/Reviewer/Tester)</Text>}
            {subAgent && subLines.length === 0 && <Text dimColor>(รอผลลัพธ์...)</Text>}
            {wrapLines(subLines, subWidth - PANEL_INNER_PADDING)
              .slice(-visibleRows)
              .map((l, i) => (
                <Text key={i} wrap="truncate-end">
                  {l}
                </Text>
              ))}
          </Box>
        )}
      </Box>
      {!showSubPanel && (
        <Text dimColor>ขยายเทอร์มินัลให้กว้าง ≥100 คอลัมน์ เพื่อดูพาเนล Dev/Reviewer/Tester แยก</Text>
      )}
    </Box>
  );
}

/**
 * Interactive, single-screen alternative to running `pmctl run` and
 * `pmctl watch` in two separate terminals: renders a PM→Dev→Tester todo
 * checklist next to the PM session's live output, in one Ink UI that fills
 * the real terminal and follows it on resize. Falls back to spawnPmSession
 * (plain stdout streaming) when stdin/stdout aren't a real TTY — see
 * src/cli.ts.
 */
export function runPmSessionWithTui(
  repoRoot: string,
  meta: Meta,
  permissionMode: string,
  clickupRef: string,
  briefMode: string = "ask",
  commitOnFinish: boolean = true
): Promise<number> {
  return new Promise((resolve) => {
    render(
      <App
        repoRoot={repoRoot}
        meta={meta}
        permissionMode={permissionMode}
        clickupRef={clickupRef}
        briefMode={briefMode}
        commitOnFinish={commitOnFinish}
        onDone={resolve}
      />
    );
  });
}
