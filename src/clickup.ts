/**
 * READ-ONLY by design.
 *
 * This file must only ever issue GET requests to the ClickUp API.
 * Do not add a write/update/comment call here — the whole point of this
 * module is that PM (and everything it spawns) never gets write access
 * to ClickUp. PO is the only one who writes to ClickUp.
 *
 * Real enforcement: CLICKUP_API_TOKEN is read here, in the pmctl parent
 * process, and is deliberately NOT forwarded into the environment of the
 * `claude` subprocesses pmctl spawns (see agents.ts). So even if a PM/Dev/
 * Tester session tried to call the ClickUp API itself, it has no token.
 */

export interface ClickUpTask {
  id: string;
  name: string;
  description: string;
  status: string;
  url: string;
  customFields: { name: string; value: unknown }[];
}

export async function fetchClickUpTask(taskId: string): Promise<ClickUpTask> {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    throw new Error(
      "ไม่พบ CLICKUP_API_TOKEN ใน environment — ตั้งค่าก่อนรัน (export CLICKUP_API_TOKEN=...)"
    );
  }

  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: "GET",
    headers: { Authorization: token },
  });

  if (!res.ok) {
    throw new Error(`ดึง ClickUp task ไม่สำเร็จ: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  return {
    id: data.id,
    name: data.name,
    description: data.text_content ?? data.description ?? "",
    status: data.status?.status ?? "unknown",
    url: data.url,
    customFields: (data.custom_fields ?? []).map((f: any) => ({
      name: f.name,
      value: f.value,
    })),
  };
}

export function taskToSpecMarkdown(task: ClickUpTask): string {
  const fields = task.customFields
    .map((f) => `- **${f.name}**: ${JSON.stringify(f.value)}`)
    .join("\n");

  return `# ${task.name}

> ที่มา: [ClickUp task ${task.id}](${task.url}) — ดึงมาตอนเริ่ม flow นี้ (read-only, snapshot ณ เวลานั้น)

**สถานะใน ClickUp:** ${task.status}

## รายละเอียด

${task.description || "(ไม่มีคำอธิบายใน ClickUp)"}

## Custom fields

${fields || "(ไม่มี)"}

---
หมายเหตุสำหรับ PM: นี่คือ snapshot ตอนเริ่มงาน ไม่ใช่ live sync — ถ้า PO แก้ไข task ใน ClickUp ภายหลัง ต้องให้ PO บอก หรือรัน \`pmctl refresh-spec\` ใหม่
`;
}
