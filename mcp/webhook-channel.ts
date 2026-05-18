#!/usr/bin/env bun
/**
 * Vexa Webhook Channel — 接收 bot-manager 的會議結束通知，推進 Claude Code session
 *
 * 根據官方文件：https://code.claude.com/docs/zh-TW/channels-reference
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { appendFileSync } from 'fs'
import postgres from 'postgres'

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "8901", 10);
const LOG_FILE = new URL("./webhook-channel.log", import.meta.url).pathname;

// Vexa Postgres 連線（用來補 webhook payload 缺漏的 native_meeting_id）
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5458/vexa";
const sql = postgres(DATABASE_URL, {
  max: 2,
  idle_timeout: 30,
  connect_timeout: 5,
  onnotice: () => {},
});

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}\n`;
  console.error(line.trim());
  try { appendFileSync(LOG_FILE, line); } catch {}
}

/** 用 meeting.id 從 Vexa DB 查 platform_specific_id（native_meeting_id） */
async function lookupNativeMeetingId(meetingId: unknown): Promise<{ value: string; ok: boolean }> {
  if (meetingId === undefined || meetingId === null || meetingId === "") {
    return { value: "", ok: false };
  }
  try {
    const rows = await sql<{ platform_specific_id: string | null }[]>`
      SELECT platform_specific_id
      FROM meetings
      WHERE id = ${meetingId as number}
    `;
    const first = rows[0];
    if (first && first.platform_specific_id) {
      return { value: first.platform_specific_id, ok: true };
    }
    return { value: "", ok: false };
  } catch (err) {
    log(`DB lookup error for meeting ${meetingId}: ${err}`);
    return { value: "", ok: false };
  }
}

// 建立 MCP 伺服器並聲明為 channel
const mcp = new Server(
  { name: 'vexa-webhook', version: '1.0.0' },
  {
    // 這個是讓它成為 channel 的關鍵
    capabilities: { experimental: { 'claude/channel': {} } },
    // 加入 Claude 的系統提示
    instructions: [
      '來自 vexa-webhook channel 的事件是會議結束通知。',
      '收到通知後，請立即呼叫 summarize_meeting 工具處理該會議。',
      '完成後把摘要和 Action Items 寫入 Google Sheets，在 Google Drive 建立會議記錄，並透過 TG 發送摘要給團隊。',
    ].join(' '),
  },
)

// 透過 stdio 連接到 Claude Code
await mcp.connect(new StdioServerTransport())
log("MCP channel connected via stdio")

// 去重：5 秒內同一個 meeting_id 只處理一次
const recentMeetings = new Map<string, number>();

// 啟動 HTTP 伺服器，接收 meeting-api 的 webhook
Bun.serve({
  port: WEBHOOK_PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", port: WEBHOOK_PORT }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Daily reminder trigger
    if (req.method === "POST" && url.pathname === "/hooks/daily-reminder") {
      try {
        const chatId = url.searchParams.get("chat_id") || "";
        const department = url.searchParams.get("department") || "";
        const sheetId = url.searchParams.get("sheet_id") || "";
        log(`Daily reminder triggered: chat_id=${chatId} department=${department}`);

        const content = [
          `⏰ 每日跟催檢查`,
          ``,
          chatId ? `chat_id: ${chatId}` : "",
          department ? `部門: ${department}` : "",
          sheetId ? `sheet_id: ${sheetId}` : "",
          ``,
          `請檢查該部門 Google Sheets 中的 Action Items：`,
          `1. 找出未完成的任務（預計完成時間 < 今天 且 狀態 ≠ 已完成）`,
          `2. 找出截止前 1 天的任務（即將到期）`,
          `3. 產生跟催報告並透過 TG 發送到該部門的群組`,
          `4. 如果沒有需要跟催的項目，不發送任何通知`,
        ].filter(Boolean).join("\n");

        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: content,
            meta: { event: "daily_reminder", chat_id: chatId, department: department, sheet_id: sheetId },
          },
        });

        log(`Daily reminder notification SENT`);
        return new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        log(`Daily reminder error: ${err}`);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Meeting completed webhook
    if (req.method === "POST" && url.pathname === "/hooks/meeting-completed") {
      try {
        const body = await req.text();
        log(`Webhook raw body: ${body}`);
        const payload = JSON.parse(body);
        const meeting = payload.data?.meeting || payload.meeting || {};
        const meetingId = meeting.id;
        const payloadNativeMeetingId = meeting.native_meeting_id || "";
        const platform = meeting.platform || "google_meet";
        const startTime = meeting.start_time || "";
        const endTime = meeting.end_time || "";
        const eventType = payload.event_type || "meeting.completed";

        // Vexa webhook payload 不帶 native_meeting_id，要自己用 meeting.id 查 DB
        const dbLookup = await lookupNativeMeetingId(meetingId);
        const nativeMeetingId = dbLookup.ok ? dbLookup.value : payloadNativeMeetingId;

        log(
          `Webhook received: meeting_id=${meetingId} ` +
          `native_meeting_id=${nativeMeetingId} ` +
          `db_lookup_succeeded=${dbLookup.ok} ` +
          `payload_native_meeting_id=${payloadNativeMeetingId || "(empty)"} ` +
          `platform=${platform} event=${eventType}`
        );

        // 去重檢查
        const dedupeKey = String(meetingId);
        const now = Date.now();
        const lastSeen = recentMeetings.get(dedupeKey);
        if (lastSeen && (now - lastSeen) < 5000) {
          log(`Duplicate webhook for meeting ${meetingId}, skipping (${now - lastSeen}ms ago)`);
          return new Response(JSON.stringify({ status: "duplicate_skipped" }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        recentMeetings.set(dedupeKey, now);

        // 立刻把 nb_meetings 占位 row 的 status 從「會議進行中」改為「逐字稿處理中」
        // 讓 Dashboard 在 sub-agent 還沒跑完前能顯示更精確的狀態
        if (nativeMeetingId) {
          try {
            const updated = await sql`
              UPDATE nb_meetings
              SET status = '逐字稿處理中'
              WHERE meet_id = ${nativeMeetingId} AND status = '會議進行中'
              RETURNING id
            `;
            log(`Status transition: meet_id=${nativeMeetingId} → 逐字稿處理中 (rows=${updated.length})`);
          } catch (err) {
            log(`Status transition error for ${nativeMeetingId}: ${err}`);
          }
        }

        // 按官方格式推 channel notification
        const content = [
          `🔔 會議結束通知`,
          ``,
          `會議 (DB ID: ${meetingId}, Meet ID: ${nativeMeetingId}) 已結束。`,
          ``,
          `⚠️ 請用 Agent tool 生成 sub-agent 處理，主 agent 保持空閒接收其他請求。`,
          ``,
          `Sub-agent 執行步驟：`,
          `1. 呼叫 send_processing(chat_id) 發送處理中提示`,
          `2. 呼叫 summarize_meeting(meeting_id=${meetingId}) 取得逐字稿`,
          `   - native_meeting_id: ${nativeMeetingId}`,
          `3. 產生摘要和 Action Items`,
          `4. 把 Action Items 寫入 Google Sheets`,
          `5. 在 Google Drive 建立會議記錄（含摘要 + Action Items + 完整逐字稿）`,
          `6. 用 edit_message 更新處理中狀態為完成`,
          `7. 透過 TG 發送完整摘要給團隊（含 Google Sheet 和 Doc 連結）`,
        ].join("\n");

        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: content,
            meta: {
              event: eventType,
              meeting_id: String(meetingId),
              native_meeting_id: nativeMeetingId,
              platform: platform,
              start_time: startTime,
              end_time: endTime,
            },
          },
        });

        log(`Channel notification SENT for meeting ${meetingId}`);
        return new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        log(`Error: ${err}`);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  },
});

log(`HTTP webhook server listening on port ${WEBHOOK_PORT}`);
