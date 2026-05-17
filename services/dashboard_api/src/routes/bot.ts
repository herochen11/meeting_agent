import { readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { sql } from "../db";
import { getDeptId, requireDept, type DeptVars } from "../auth";

export const botRoute = new Hono<{ Variables: DeptVars }>();

botRoute.use("/api/bot/*", requireDept);

const VEXA_BASE = process.env.VEXA_API_BASE ?? "http://localhost:8056";
const VEXA_KEY = process.env.VEXA_USER_API_KEY ?? "";
const MEETING_MAP_PATH =
  process.env.MEETING_MAP_PATH ??
  "/home/user/Agents/meeting_agent/config/meeting_map.json";

async function readMeetingMap(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(MEETING_MAP_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch (err) {
    return {};
  }
}

async function writeMeetingMap(map: Record<string, string>): Promise<void> {
  await writeFile(
    MEETING_MAP_PATH,
    JSON.stringify(map, null, 2) + "\n",
    "utf-8",
  );
}

async function getDeptChatId(deptId: number): Promise<string | null> {
  const rows = await sql<{ chat_id: string | null }[]>`
    SELECT chat_id FROM nb_departments
    WHERE id = ${deptId} LIMIT 1
  `;
  return rows[0]?.chat_id ?? null;
}

interface VexaBotInfo {
  platform?: string;
  native_meeting_id?: string;
  // ... 其他欄位
  [key: string]: unknown;
}

interface VexaStatusResponse {
  running_bots?: VexaBotInfo[];
  [key: string]: unknown;
}

botRoute.get("/api/bot/status", async (c) => {
  if (!VEXA_KEY) {
    return c.json({ error: "伺服器未設定 VEXA_USER_API_KEY" }, 500);
  }

  const deptId = getDeptId(c);
  const chatId = await getDeptChatId(deptId);
  if (!chatId) {
    return c.json({ error: "本部門未設定 chat_id" }, 400);
  }

  let res: Response;
  try {
    res = await fetch(`${VEXA_BASE}/bots/status`, {
      headers: { "X-API-Key": VEXA_KEY },
    });
  } catch (err) {
    return c.json(
      { error: `無法連線到 Vexa API：${(err as Error).message}` },
      502,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return c.json(
      { error: `Vexa API 回應錯誤 (${res.status})`, detail: text.slice(0, 500) },
      502,
    );
  }

  const data = (await res.json().catch(() => ({}))) as VexaStatusResponse;
  const allBots = Array.isArray(data.running_bots) ? data.running_bots : [];

  const map = await readMeetingMap();
  const filtered = allBots.filter((b) => {
    const meetId = typeof b.native_meeting_id === "string" ? b.native_meeting_id : null;
    if (!meetId) return false;
    return map[meetId] === chatId;
  });

  return c.json({ count: filtered.length, bots: filtered });
});

interface JoinBody {
  meet_id?: unknown;
  bot_name?: unknown;
}

botRoute.post("/api/bot/join", async (c) => {
  if (!VEXA_KEY) {
    return c.json({ error: "伺服器未設定 VEXA_USER_API_KEY" }, 500);
  }

  const deptId = getDeptId(c);

  let body: JoinBody;
  try {
    body = (await c.req.json()) as JoinBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 body" }, 400);
  }

  const meetId =
    typeof body.meet_id === "string" ? body.meet_id.trim() : "";
  if (!meetId) {
    return c.json({ error: "meet_id 為必填" }, 400);
  }
  // 寬鬆驗證：Google Meet ID 通常是 xxx-xxxx-xxx
  if (!/^[a-z0-9-]{3,32}$/i.test(meetId)) {
    return c.json({ error: "meet_id 格式不合法" }, 400);
  }

  const botName =
    typeof body.bot_name === "string" && body.bot_name.trim()
      ? body.bot_name.trim()
      : "NoirsBoxes Meeting Bot";

  const chatId = await getDeptChatId(deptId);
  if (!chatId) {
    return c.json({ error: "本部門未設定 chat_id" }, 400);
  }

  let res: Response;
  try {
    res = await fetch(`${VEXA_BASE}/bots`, {
      method: "POST",
      headers: {
        "X-API-Key": VEXA_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform: "google_meet",
        native_meeting_id: meetId,
        bot_name: botName,
      }),
    });
  } catch (err) {
    return c.json(
      { error: `無法連線到 Vexa API：${(err as Error).message}` },
      502,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return c.json(
      { error: `Vexa API 回應錯誤 (${res.status})`, detail: text.slice(0, 500) },
      502,
    );
  }

  const data = (await res.json().catch(() => ({}))) as {
    id?: number;
    [key: string]: unknown;
  };

  // 只在 Vexa 派發成功後才寫 meeting_map
  try {
    const map = await readMeetingMap();
    map[meetId] = chatId;
    await writeMeetingMap(map);
  } catch (err) {
    // 派發成功但 map 寫失敗，回 200 但帶 warning
    return c.json({
      success: true,
      meeting_id: data.id ?? null,
      warning: `meeting_map.json 寫入失敗：${(err as Error).message}`,
    });
  }

  return c.json({ success: true, meeting_id: data.id ?? null });
});

interface StopBody {
  meet_id?: unknown;
}

botRoute.post("/api/bot/stop", async (c) => {
  if (!VEXA_KEY) {
    return c.json({ error: "伺服器未設定 VEXA_USER_API_KEY" }, 500);
  }

  const deptId = getDeptId(c);

  let body: StopBody;
  try {
    body = (await c.req.json()) as StopBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 body" }, 400);
  }

  const meetId =
    typeof body.meet_id === "string" ? body.meet_id.trim() : "";
  if (!meetId) {
    return c.json({ error: "meet_id 為必填" }, 400);
  }

  const chatId = await getDeptChatId(deptId);
  if (!chatId) {
    return c.json({ error: "本部門未設定 chat_id" }, 400);
  }

  // 確認該 meet_id 屬於 caller 部門
  const map = await readMeetingMap();
  const mappedChatId = map[meetId];
  if (!mappedChatId) {
    return c.json({ error: "此會議不在派發記錄中" }, 404);
  }
  if (mappedChatId !== chatId) {
    return c.json({ error: "此會議不屬於本部門" }, 403);
  }

  let res: Response;
  try {
    res = await fetch(
      `${VEXA_BASE}/bots/google_meet/${encodeURIComponent(meetId)}`,
      {
        method: "DELETE",
        headers: { "X-API-Key": VEXA_KEY },
      },
    );
  } catch (err) {
    return c.json(
      { error: `無法連線到 Vexa API：${(err as Error).message}` },
      502,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return c.json(
      { error: `Vexa API 回應錯誤 (${res.status})`, detail: text.slice(0, 500) },
      502,
    );
  }

  return c.json({ success: true });
});
