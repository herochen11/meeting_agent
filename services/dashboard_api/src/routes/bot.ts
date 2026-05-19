import { readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { sql } from "../db";
import { getDeptId, requireDept, type DeptVars } from "../auth";
import { buildRecap, sendTgMessage } from "../lib/recap";

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

interface BotStatusEntry {
  meet_id: string;
  status: "等待加入" | "進行中" | "逐字稿處理中";
  vexa_meeting_id: number | null;
  started_at: string | null;
  source: "vexa-bot" | "local-recording";
  title: string | null;
}

botRoute.get("/api/bot/status", async (c) => {
  if (!VEXA_KEY) {
    return c.json({ error: "伺服器未設定 VEXA_USER_API_KEY" }, 500);
  }

  const deptId = getDeptId(c);

  // 1. 撈 Vexa running_bots（交叉比對 + 偵測 bot 是否已加入）
  //    Vexa 不通也不擋；此時所有等待加入的 row 維持等待加入即可
  let runningMeetIds = new Set<string>();
  let vexaUnavailable = false;
  try {
    const res = await fetch(`${VEXA_BASE}/bots/status`, {
      headers: { "X-API-Key": VEXA_KEY },
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as VexaStatusResponse;
      const allBots = Array.isArray(data.running_bots) ? data.running_bots : [];
      for (const b of allBots) {
        if (typeof b.native_meeting_id === "string" && b.native_meeting_id) {
          runningMeetIds.add(b.native_meeting_id);
        }
      }
    } else {
      vexaUnavailable = true;
    }
  } catch {
    vexaUnavailable = true;
  }

  // 2. 撈 nb_meetings：本部門所有「進行中 / 等待中 / 處理中」的 row
  //    部門隔離以 department_id 為準，不再讀 meeting_map.json
  //    包含 source='local-recording' — 本地錄音也算「處理中」，前端會用 mic icon 區分顯示
  const rows = await sql<
    {
      meet_id: string;
      vexa_meeting_id: number | null;
      status: string;
      start_time: string | null;
      source: string | null;
      title: string | null;
    }[]
  >`
    SELECT meet_id, vexa_meeting_id, status, start_time,
           COALESCE(source, 'vexa-bot') AS source, title
    FROM nb_meetings
    WHERE department_id = ${deptId}
      AND status IN ('等待加入', '會議進行中', '逐字稿處理中')
    ORDER BY start_time DESC NULLS LAST, id DESC
  `;

  // 3. 自動轉場：'等待加入' 且 meet_id 出現在 Vexa running_bots → 改為 '會議進行中'
  const toPromote: string[] = [];
  for (const r of rows) {
    if (r.status === "等待加入" && runningMeetIds.has(r.meet_id)) {
      toPromote.push(r.meet_id);
    }
  }
  if (toPromote.length > 0) {
    try {
      await sql`
        UPDATE nb_meetings
        SET status = '會議進行中'
        WHERE department_id = ${deptId}
          AND status = '等待加入'
          AND meet_id = ANY(${toPromote})
      `;
    } catch (err) {
      console.warn(
        `等待加入 → 會議進行中 自動轉場失敗：${(err as Error).message}`,
      );
    }
  }

  // 4. 整理回應：把 DB status 對應到顯示用 status
  //    - 等待加入 → 等待加入
  //    - 會議進行中 → 進行中（不論 Vexa 是否還列出該 bot，DB 為主）
  //    - 逐字稿處理中 → 逐字稿處理中
  const bots: BotStatusEntry[] = rows.map((r) => {
    let displayStatus: BotStatusEntry["status"];
    if (r.status === "等待加入") {
      // 若剛轉場到「會議進行中」，回應也順手反映
      displayStatus = runningMeetIds.has(r.meet_id) ? "進行中" : "等待加入";
    } else if (r.status === "會議進行中") {
      displayStatus = "進行中";
    } else {
      displayStatus = "逐字稿處理中";
    }
    const source: BotStatusEntry["source"] =
      r.source === "local-recording" ? "local-recording" : "vexa-bot";
    // 本地錄音不會出現在 Vexa running_bots，displayStatus 強制標為「逐字稿處理中」
    const finalStatus: BotStatusEntry["status"] =
      source === "local-recording" ? "逐字稿處理中" : displayStatus;
    return {
      meet_id: r.meet_id,
      status: finalStatus,
      vexa_meeting_id: r.vexa_meeting_id,
      started_at: r.start_time,
      source,
      title: r.title,
    };
  });

  const response: {
    count: number;
    bots: BotStatusEntry[];
    warning?: string;
  } = {
    count: bots.length,
    bots,
  };
  if (vexaUnavailable) {
    response.warning = "Vexa API 暫時無法連線，狀態以 DB 為準";
  }
  return c.json(response);
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
      : "NoirsBoxes 會議助理";

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
  const vexaMeetingId = data.id ?? null;

  // 只在 Vexa 派發成功後才寫 meeting_map
  let mapWarning: string | null = null;
  try {
    const map = await readMeetingMap();
    map[meetId] = chatId;
    await writeMeetingMap(map);
  } catch (err) {
    mapWarning = `meeting_map.json 寫入失敗：${(err as Error).message}`;
  }

  // INSERT 占位 row 到 nb_meetings（等待加入），讓 Dashboard 立刻顯示
  // 等待加入 = bot 已派發但尚未實際加入會議（host 還沒 admit / Vexa 容器啟動中）
  // /api/bot/status 偵測到 meet_id 出現在 Vexa running_bots 後會自動轉成「會議進行中」
  // 失敗只 log warning，不擋整個 API 成功
  let placeholderWarning: string | null = null;
  try {
    await sql`
      INSERT INTO nb_meetings
        (department_id, vexa_meeting_id, title, meet_id, platform, status, start_time)
      SELECT ${deptId}, ${vexaMeetingId}, '待定', ${meetId}, 'Google Meet', '等待加入', NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM nb_meetings
        WHERE meet_id = ${meetId} AND status IN ('等待加入', '會議進行中')
      )
    `;
  } catch (err) {
    placeholderWarning = `nb_meetings 占位 INSERT 失敗（不影響派 bot）：${(err as Error).message}`;
    console.warn(placeholderWarning);
  }

  // 發 recap 到該部門群組（失敗只 warning，不擋 join 流程）
  try {
    const recap = await buildRecap(deptId, meetId);
    if (recap) {
      await sendTgMessage(chatId, recap);
    }
  } catch (err) {
    console.warn(`Recap 發送失敗：${(err as Error).message}`);
  }

  const response: {
    success: true;
    meeting_id: number | null;
    warning?: string;
  } = {
    success: true,
    meeting_id: vexaMeetingId,
  };
  const warnings = [mapWarning, placeholderWarning].filter(
    (w): w is string => w !== null,
  );
  if (warnings.length > 0) {
    response.warning = warnings.join("; ");
  }
  return c.json(response);
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
