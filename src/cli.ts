#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createWorktree, loadMeta, removeWorktree } from "./worktree.js";
import { fetchClickUpTask, taskToSpecMarkdown } from "./clickup.js";
import { appendLog, formatLog, readLog } from "./log.js";
import { featureDir, featureFile, stateRoot } from "./paths.js";
import { spawnPmSession } from "./agents.js";

const repoRoot = process.cwd();
const program = new Command();

program
  .name("pmctl")
  .description(
    "Local PO -> PM agent -> Dev agent -> Tester agent orchestrator, built on the claude CLI (Claude Code)."
  );

program
  .command("run <feature>")
  .description("สร้าง worktree ใหม่ ดึง spec จาก ClickUp แล้วเริ่ม PM session")
  .requiredOption("--clickup <taskId>", "ClickUp task id ที่เป็น spec ของ feature นี้")
  .option("--permission-mode <mode>", "permission mode ที่ส่งให้ PM session", "acceptEdits")
  .action(async (feature: string, opts: { clickup: string; permissionMode: string }) => {
    console.log(`[pmctl] สร้าง worktree + ดึง spec สำหรับ feature "${feature}"...`);
    const meta = createWorktree(repoRoot, feature, opts.clickup);

    const task = await fetchClickUpTask(opts.clickup);
    fs.writeFileSync(featureFile(repoRoot, feature, "spec"), taskToSpecMarkdown(task));

    appendLog(repoRoot, feature, {
      actor: "system",
      step: "feature_created",
      reason: `pmctl run เริ่มงานใหม่จาก ClickUp task ${opts.clickup}`,
      result: `worktree=${meta.worktreePath} port=${meta.port}`,
    });

    console.log(`[pmctl] spec พร้อมแล้วที่ ${featureFile(repoRoot, feature, "spec")}`);
    await spawnPmSession(repoRoot, meta, opts.permissionMode);
  });

program
  .command("refresh-spec <feature>")
  .description("ดึง ClickUp task ใหม่อีกรอบ เผื่อ PO แก้ไข task ไปแล้วหลังเริ่มงาน")
  .requiredOption("--clickup <taskId>")
  .action(async (feature: string, opts: { clickup: string }) => {
    const task = await fetchClickUpTask(opts.clickup);
    fs.writeFileSync(featureFile(repoRoot, feature, "spec"), taskToSpecMarkdown(task));
    appendLog(repoRoot, feature, {
      actor: "system",
      step: "spec_refreshed",
      reason: "PO ขอดึง ClickUp task ใหม่ระหว่างทำงาน",
    });
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
