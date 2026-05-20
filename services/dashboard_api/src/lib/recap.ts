import { readFile } from "node:fs/promises";
import { sql } from "../db";

const CONFIG_PATH =
  process.env.CONFIG_FILE ??
  "/home/user/Agents/meeting_agent/config/departments.json";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const TG_API_BASE = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : "";
const TG_MAX_LEN = 4096;

interface Member {
  system_name?: string;
  tg_username?: string;
  transcript_names?: string[];
}

interface ConfigShape {
  members?: Member[];
}

async function readMembers(): Promise<Member[]> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ConfigShape;
    return Array.isArray(parsed.members) ? parsed.members : [];
  } catch {
    return [];
  }
}

function ownerToTag(owner: string | null, members: Member[]): string {
  if (!owner || !owner.trim()) return "待確認";
  const trimmed = owner.trim();
  const m = members.find(
    (mem) =>
      mem.system_name === trimmed ||
      (mem.transcript_names ?? []).includes(trimmed),
  );
  if (m?.tg_username) {
    return m.tg_username.startsWith("@") ? m.tg_username : `@${m.tg_username}`;
  }
  return trimmed;
}

function formatDueDate(d: Date | string | null): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function statusTag(status: string | null): string {
  if (status === "進行中") return "[進行中]";
  if (status === "未開始") return "[未開始]";
  return `[${status ?? "未知"}]`;
}

// 進行中 → 0；未開始 → 1；其他 → 2（理論上撈不到「已完成」）
function statusOrder(status: string | null): number {
  if (status === "進行中") return 0;
  if (status === "未開始") return 1;
  return 2;
}

interface RecapActionItem {
  code: string;
  description: string;
  assignee: string | null;
  status: string | null;
  due_date: Date | string | null;
}

interface RecapMeetingSummary {
  summary: string | null;
}

export async function buildRecap(
  deptId: number,
  meetId: string,
): Promise<string | null> {
  // 1. 上次該部門 completed 會議的 summary（排除本次 meet_id）
  const lastMeetingRows = await sql<RecapMeetingSummary[]>`
    SELECT summary
    FROM nb_meetings
    WHERE department_id = ${deptId}
      AND status = 'completed'
      AND meet_id IS DISTINCT FROM ${meetId}
    ORDER BY end_time DESC NULLS LAST, id DESC
    LIMIT 1
  `;
  const lastSummary = lastMeetingRows[0]?.summary?.trim() ?? "";

  // 2. 未完成 Action Items（依 code 排序，後面再依 assignee + status 重排）
  const items = await sql<RecapActionItem[]>`
    SELECT code, description, assignee, status, due_date
    FROM nb_action_items
    WHERE department_id = ${deptId}
      AND (status IS NULL OR status != '已完成')
    ORDER BY code ASC
  `;

  const members = await readMembers();

  // 3. 分組：assignee → items
  const groups = new Map<string, RecapActionItem[]>();
  for (const it of items) {
    const tag = ownerToTag(it.assignee, members);
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(it);
  }
  // 每組內：進行中先 → 未開始 → 其他；同 status 內按 code asc
  for (const [, arr] of groups) {
    arr.sort((a, b) => {
      const so = statusOrder(a.status) - statusOrder(b.status);
      if (so !== 0) return so;
      return (a.code ?? "").localeCompare(b.code ?? "");
    });
  }
  // group 排序：tag 字典序，但「待確認」放最後
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => {
    if (a === "待確認" && b !== "待確認") return 1;
    if (b === "待確認" && a !== "待確認") return -1;
    return a.localeCompare(b);
  });

  // 4. 組訊息
  const lines: string[] = [];
  lines.push("🔔 NoirsBoxes 會議 Recap");
  lines.push("");
  lines.push(`📅 即將開始：${meetId}`);
  lines.push("");

  if (lastSummary) {
    // 取摘要第一段（前 300 字以內）
    const firstChunk = lastSummary.split(/\n\n+/)[0] ?? lastSummary;
    const trimmed =
      firstChunk.length > 300 ? firstChunk.slice(0, 300) + "…" : firstChunk;
    lines.push("【上次會議重點】");
    lines.push(trimmed);
    lines.push("");
  }

  lines.push(`【待跟進事項】（${items.length} 個）`);
  if (items.length === 0) {
    lines.push("目前沒有未完成的 Action Items");
  } else {
    lines.push("依負責人分組，同 owner 內進行中先：");
    lines.push("");
    for (const [tag, arr] of sortedGroups) {
      lines.push(tag);
      for (const it of arr) {
        const due = formatDueDate(it.due_date);
        const dueStr = due ? ` 截止 ${due}` : "";
        lines.push(
          `• ${it.code} ${it.description} ${statusTag(it.status)}${dueStr}`,
        );
      }
      lines.push("");
    }
  }

  lines.push("────────────");
  lines.push("祝會議順利");

  return lines.join("\n");
}

export async function sendTgMessage(
  chatId: string,
  text: string,
): Promise<void> {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN 未設定");
  }
  if (!chatId) {
    throw new Error("缺少 chat_id");
  }

  // 切 TG 4096 字元上限
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TG_MAX_LEN) {
    // 找最後一個換行避免在字中間切斷
    let cut = remaining.lastIndexOf("\n", TG_MAX_LEN);
    if (cut < TG_MAX_LEN / 2) cut = TG_MAX_LEN;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);

  for (const chunk of chunks) {
    const res = await fetch(`${TG_API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Telegram API ${res.status}: ${detail.slice(0, 200)}`,
      );
    }
  }
}
