#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import { createWorktree, loadMeta, removeWorktree } from "./worktree.js";
import { appendLog, formatLog, readLog } from "./log.js";
import { featureFile, stateRoot } from "./paths.js";
import { spawnPmSession, spawnRefreshSpec } from "./agents.js";
import { watchFeatures } from "./watch.js";
import { runTui } from "./tui.js";

const repoRoot = process.cwd();
const program = new Command();

program
  .name("pmctl")
  .description(
    "Local PO -> PM agent -> Dev agent -> Tester agent orchestrator, built on the claude CLI (Claude Code)."
  );

program
  .command("run <feature>")
  .description(
    "สร้าง worktree จาก branch ที่คุณสร้างไว้แล้ว แล้วเริ่ม PM session (PM จะดึง spec จาก ClickUp เองผ่าน connector ของคุณ)",
  )
  .requiredOption("--clickup <ref>", "ClickUp task id หรือวาง URL เต็มก็ได้ (เช่น https://app.clickup.com/t/9018044177/DSAG-218)")
  .option(
    "--branch <name>",
    "ชื่อ branch ที่สร้างไว้ล่วงหน้าแล้ว (ต้องมีอยู่จริง pmctl จะไม่สร้างให้) ค่าเริ่มต้นคือ feature/<feature>",
  )
  .option("--permission-mode <mode>", "permission mode ที่ส่งให้ PM session", "acceptEdits")
  .action(async (feature: string, opts: { clickup: string; branch?: string; permissionMode: string }) => {
    console.log(`[pmctl] สร้าง worktree สำหรับ feature "${feature}"...`);
    const meta = createWorktree(repoRoot, feature, opts.clickup, opts.branch);

    appendLog(repoRoot, feature, {
      actor: "system",
      step: "feature_created",
      reason: `pmctl run เริ่มงานใหม่จาก ClickUp task ${opts.clickup}`,
      result: `worktree=${meta.worktreePath} port=${meta.port}`,
    });

    await spawnPmSession(repoRoot, meta, opts.permissionMode, opts.clickup);
  });

program
  .command("refresh-spec <feature>")
  .description("สั่งให้ PM ดึง ClickUp task ใหม่อีกรอบทับ spec.md เผื่อ PO แก้ไข task ไปแล้วหลังเริ่มงาน")
  .requiredOption("--clickup <ref>")
  .action(async (feature: string, opts: { clickup: string }) => {
    const meta = loadMeta(repoRoot, feature);
    appendLog(repoRoot, feature, {
      actor: "system",
      step: "spec_refresh_requested",
      reason: "PO ขอดึง ClickUp task ใหม่ระหว่างทำงาน",
    });
    await spawnRefreshSpec(repoRoot, meta, opts.clickup);
    console.log(`[pmctl] อัปเดต spec.md แล้ว`);
  });

program
  .command("status")
  .description("แสดงรายการ feature ทั้งหมดที่กำลังทำอยู่")
  .action(() => {
    const root = stateRoot(repoRoot);
    if (!fs.existsSync(root)) {
      console.log("ยังไม่มี feature ไหนเริ่มทำงานเลย");
      return;
    }
    for (const feature of fs.readdirSync(root)) {
      try {
        const meta = loadMeta(repoRoot, feature);
        const log = readLog(repoRoot, feature);
        const last = log[log.length - 1];
        console.log(
          `- ${feature} (branch ${meta.branch}, port ${meta.port})` +
            (last ? `\n    ล่าสุด: [${last.actor}] ${last.step}` : "")
        );
      } catch {
        /* skip malformed feature dirs */
      }
    }
  });

program
  .command("log <feature>")
  .description("ไล่ดู log การทำงานทั้งหมดของ feature นี้ (append-only, ไม่อยู่ใน ClickUp)")
  .action((feature: string) => {
    console.log(formatLog(readLog(repoRoot, feature)));
  });

program
  .command("plan <feature>")
  .description("เปิดอ่านแผนงาน (plan.md) ของ feature นี้")
  .action((feature: string) => {
    const file = featureFile(repoRoot, feature, "plan");
    console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(PM ยังไม่เขียนแผนงาน)");
  });

program
  .command("report <feature>")
  .description("เปิดอ่านผลเทส (report.md) ของ feature นี้")
  .action((feature: string) => {
    const file = featureFile(repoRoot, feature, "report");
    console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(Tester ยังไม่เขียนผลเทส)");
  });

program
  .command("watch")
  .description("เปิด TUI แบบ interactive ดูทุก feature + agent ตัวไหนกำลังทำอะไรอยู่ (เปิดอีก terminal คู่กับ pmctl run ได้)")
  .option("--interval <ms>", "ความถี่ในการ refresh สำหรับโหมด non-interactive (ms)", "1500")
  .option("--plain", "บังคับใช้โหมด non-interactive (plain polling) แม้มี TTY ก็ตาม")
  .action((opts: { interval: string; plain?: boolean }) => {
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY && !opts.plain;
    if (isInteractive) {
      runTui(repoRoot);
    } else {
      // ไม่มี TTY จริง (เช่นรันผ่าน pipe/CI) — ใช้โหมด plain เพราะ Ink
      // ต้องการ raw-mode stdin ซึ่งใช้ไม่ได้ในสภาพแวดล้อมแบบนั้น
      watchFeatures(repoRoot, Number(opts.interval));
    }
  });

program
  .command("clean <feature>")
  .description("ลบ worktree ของ feature นี้ทิ้ง (ทำหลังจาก merge/ปิดงานแล้ว)")
  .action((feature: string) => {
    removeWorktree(repoRoot, feature);
    console.log(`[pmctl] ลบ worktree ของ "${feature}" แล้ว (ไฟล์ log/plan/report ใน .pmctl/ ยังอยู่)`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[pmctl] error: ${msg}`);
  process.exitCode = 1;
});
