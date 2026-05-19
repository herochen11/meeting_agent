#!/usr/bin/env bun
/**
 * NoirsBoxes Calendar Poller
 *
 * 獨立背景 process，每分鐘輪詢所有 active 的 nb_calendar_accounts，
 * 找出 [now, now+10min] 內有 Google Meet 連結的事件：
 *   - T-5（4:30~5:30 前）→ 通知 webhook-channel /hooks/calendar-upcoming?phase=T-5
 *   - T-1（0:30~1:30 前）→ 通知 webhook-channel /hooks/calendar-upcoming?phase=T-1
 *
 * 去重：
 *   - T-5 用 nb_calendar_notified (event_id, phase='T-5') 防重
 *   - T-1 用 nb_calendar_auto_joined (event_id) 防重
 *
 * 不對外開 HTTP port，純背景 loop。
 */

import postgres from "postgres";
import { google, type Auth, type calendar_v3 } from "googleapis";

// ---------------------------------------------------------------------------
// 環境變數
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[poller] 環境變數 DATABASE_URL 未設定");
  process.exit(1);
}
const WEBHOOK_URL = (process.env.WEBHOOK_URL ?? "http://localhost:8901").replace(/\/$/, "");
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "60000", 10);
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";

if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
  console.warn(
    "[poller] 警告：GOOGLE_OAUTH_CLIENT_ID / SECRET 未設定，OAuth refresh 會失敗",
  );
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
  transform: { undefined: null },
});

// ---------------------------------------------------------------------------
// 型別
// ---------------------------------------------------------------------------

interface CalendarAccountRow {
  id: number;
  department_id: number;
  google_email: string;
  refresh_token: string;
  access_token: string | null;
  token_expires_at: Date | null;
  scopes: string[] | null;
}

interface UpcomingEvent {
  event_id: string;
  title: string;
  start_iso: string;
  end_iso: string;
  start_ms: number;
  meet_url: string;
  meet_code: string;
  attendees: { email: string; displayName?: string }[];
}

type Phase = "T-5" | "T-1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} ${msg}`);
}

function logErr(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`${ts} ${msg}`);
}

function newOauthClient(): Auth.OAuth2Client {
  return new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
}

/**
 * 用 account row 建立 OAuth client；自動 refresh 並把新 access_token 寫回 DB。
 */
async function buildAuthorizedClient(
  account: CalendarAccountRow,
): Promise<Auth.OAuth2Client> {
  const client = newOauthClient();
  client.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token ?? undefined,
    expiry_date: account.token_expires_at
      ? account.token_expires_at.getTime()
      : undefined,
    scope: (account.scopes ?? []).join(" "),
  });

  // googleapis 會在 expiry < 5 分鐘 / 過期時自動用 refresh_token 換新 access_token
  const { token } = await client.getAccessToken();
  const creds = client.credentials;
  if (token && creds.expiry_date && token !== account.access_token) {
    await sql`
      UPDATE nb_calendar_accounts
      SET access_token = ${token},
          token_expires_at = to_timestamp(${creds.expiry_date / 1000}),
          updated_at = NOW()
      WHERE id = ${account.id}
    `;
  }
  return client;
}

function extractMeetFromEvent(
  ev: calendar_v3.Schema$Event,
): { url: string; code: string } | null {
  const eps = ev.conferenceData?.entryPoints;
  if (eps) {
    for (const ep of eps) {
      if (ep.entryPointType === "video" && ep.uri) {
        const m = /meet\.google\.com\/([a-z0-9-]+)/i.exec(ep.uri);
        return { url: ep.uri, code: m ? m[1]! : "" };
      }
    }
  }
  // fallback：有些事件不靠 conferenceData，直接在 hangoutLink / description 內帶 URL
  if (ev.hangoutLink) {
    const m = /meet\.google\.com\/([a-z0-9-]+)/i.exec(ev.hangoutLink);
    if (m) return { url: ev.hangoutLink, code: m[1]! };
  }
  return null;
}

async function fetchEvents(
  account: CalendarAccountRow,
  fromMs: number,
  toMs: number,
): Promise<calendar_v3.Schema$Event[]> {
  let client: Auth.OAuth2Client;
  try {
    client = await buildAuthorizedClient(account);
  } catch (err) {
    logErr(
      `[poller] OAuth refresh 失敗：account_id=${account.id} email=${account.google_email} scopes=${(account.scopes ?? []).length} err=${(err as Error).message}`,
    );
    return [];
  }
  try {
    const cal = google.calendar({ version: "v3", auth: client });
    const res = await cal.events.list({
      calendarId: "primary",
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(toMs).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });
    return res.data.items ?? [];
  } catch (err) {
    logErr(
      `[poller] events.list 失敗：account_id=${account.id} email=${account.google_email} err=${(err as Error).message}`,
    );
    return [];
  }
}

function normalizeEvent(ev: calendar_v3.Schema$Event): UpcomingEvent | null {
  if (!ev.id) return null;
  // 只處理有明確 dateTime 的（all-day events 沒 dateTime，不會收 T-N 通知）
  const startIso = ev.start?.dateTime;
  const endIso = ev.end?.dateTime ?? startIso;
  if (!startIso) return null;
  const meet = extractMeetFromEvent(ev);
  if (!meet) return null;
  const startMs = new Date(startIso).getTime();
  if (Number.isNaN(startMs)) return null;
  const attendees = (ev.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => {
      const out: { email: string; displayName?: string } = { email: a.email! };
      if (a.displayName) out.displayName = a.displayName;
      return out;
    });
  return {
    event_id: ev.id,
    title: ev.summary ?? "(無標題)",
    start_iso: startIso,
    end_iso: endIso ?? startIso,
    start_ms: startMs,
    meet_url: meet.url,
    meet_code: meet.code,
    attendees,
  };
}

async function alreadyProcessed(eventId: string, phase: Phase): Promise<boolean> {
  if (phase === "T-5") {
    const rows = await sql<{ ok: number }[]>`
      SELECT 1 AS ok
      FROM nb_calendar_notified
      WHERE event_id = ${eventId} AND phase = ${phase}
      LIMIT 1
    `;
    return rows.length > 0;
  }
  // T-1：用 nb_calendar_auto_joined（避免跟既有自動加入流程衝突）
  const rows = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM nb_calendar_auto_joined
    WHERE event_id = ${eventId}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function markProcessed(
  eventId: string,
  phase: Phase,
  meetCode: string,
  deptId: number,
  email: string,
): Promise<void> {
  if (phase === "T-5") {
    await sql`
      INSERT INTO nb_calendar_notified (event_id, phase, meet_id, department_id)
      VALUES (${eventId}, ${phase}, ${meetCode}, ${deptId})
      ON CONFLICT (event_id, phase) DO NOTHING
    `;
    return;
  }
  // T-1 寫 nb_calendar_auto_joined（跟既有 schema 一致）
  await sql`
    INSERT INTO nb_calendar_auto_joined (event_id, meet_id, department_id, google_email)
    VALUES (${eventId}, ${meetCode}, ${deptId}, ${email})
    ON CONFLICT (event_id) DO NOTHING
  `;
}

async function getChatIdForDept(deptId: number): Promise<string> {
  const rows = await sql<{ chat_id: string | null }[]>`
    SELECT chat_id FROM nb_departments WHERE id = ${deptId} LIMIT 1
  `;
  return rows[0]?.chat_id ?? "";
}

async function postToWebhook(
  phase: Phase,
  payload: {
    event_id: string;
    meet_id: string;
    title: string;
    start_time: string;
    dept_id: number;
    chat_id: string;
    attendees: { email: string; displayName?: string }[];
  },
): Promise<boolean> {
  const url = `${WEBHOOK_URL}/hooks/calendar-upcoming?phase=${encodeURIComponent(phase)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, phase }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logErr(
        `[poller] webhook POST 失敗：phase=${phase} event_id=${payload.event_id} status=${res.status} body=${text.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    logErr(
      `[poller] webhook POST 例外：phase=${phase} event_id=${payload.event_id} err=${(err as Error).message}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const tickStart = new Date();
  let accountsCount = 0;
  let eventsScanned = 0;
  let triggered = 0;

  let accounts: CalendarAccountRow[] = [];
  try {
    accounts = await sql<CalendarAccountRow[]>`
      SELECT id, department_id, google_email, refresh_token, access_token,
             token_expires_at, scopes
      FROM nb_calendar_accounts
      WHERE active = TRUE
      ORDER BY id ASC
    `;
  } catch (err) {
    logErr(`[poller] DB 查 accounts 失敗：${(err as Error).message}`);
    return;
  }
  accountsCount = accounts.length;

  const now = Date.now();
  const horizon = now + 10 * 60 * 1000; // now+10min

  for (const account of accounts) {
    const rawEvents = await fetchEvents(account, now, horizon);
    for (const raw of rawEvents) {
      const ev = normalizeEvent(raw);
      if (!ev) continue;
      eventsScanned += 1;
      const startsInMs = ev.start_ms - Date.now();
      // 視窗（±30 秒）
      const phases: Phase[] = [];
      if (startsInMs >= 270_000 && startsInMs <= 330_000) phases.push("T-5");
      if (startsInMs >= 30_000 && startsInMs <= 90_000) phases.push("T-1");

      for (const phase of phases) {
        try {
          const seen = await alreadyProcessed(ev.event_id, phase);
          if (seen) continue;

          const chatId = await getChatIdForDept(account.department_id);
          const okPost = await postToWebhook(phase, {
            event_id: ev.event_id,
            meet_id: ev.meet_code,
            title: ev.title,
            start_time: ev.start_iso,
            dept_id: account.department_id,
            chat_id: chatId,
            attendees: ev.attendees,
          });
          if (!okPost) continue;

          await markProcessed(
            ev.event_id,
            phase,
            ev.meet_code,
            account.department_id,
            account.google_email,
          );
          triggered += 1;
          log(
            `[poller] triggered phase=${phase} event_id=${ev.event_id} meet=${ev.meet_code} dept_id=${account.department_id} starts_in_s=${Math.round(startsInMs / 1000)}`,
          );
        } catch (err) {
          logErr(
            `[poller] 處理事件失敗：event_id=${ev.event_id} phase=${phase} err=${(err as Error).message}`,
          );
        }
      }
    }
  }

  const elapsedMs = Date.now() - tickStart.getTime();
  log(
    `[poller] tick @ ${tickStart.toISOString()} — ${accountsCount} accounts, ${eventsScanned} events scanned, ${triggered} triggered (${elapsedMs}ms)`,
  );
}

// ---------------------------------------------------------------------------
// 啟動 + Graceful shutdown
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[poller] 收到 ${signal}，準備關閉...`);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  try {
    await sql.end({ timeout: 5 });
  } catch (err) {
    logErr(`[poller] 關閉 DB pool 失敗：${(err as Error).message}`);
  }
  log(`[poller] 已關閉`);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log(
  `[poller] 啟動 — DATABASE_URL=${DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@")} WEBHOOK_URL=${WEBHOOK_URL} POLL_INTERVAL_MS=${POLL_INTERVAL_MS}`,
);

// 首次立即跑一次，之後 setInterval
void tick().catch((err) => {
  logErr(`[poller] 首次 tick 例外：${(err as Error).message}`);
});

timer = setInterval(() => {
  void tick().catch((err) => {
    logErr(`[poller] tick 例外：${(err as Error).message}`);
  });
}, POLL_INTERVAL_MS);
