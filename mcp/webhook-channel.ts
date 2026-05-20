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

// NoirsBoxes Dashboard Postgres 連線（用來查 nb_meetings → nb_departments 的對應）
// 部門歸屬以派發 bot 時寫入 nb_meetings.department_id 為唯一來源，不再讀 meeting_map.json
const NB_DATABASE_URL =
  process.env.NB_DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5458/vexa";
const nbSql = postgres(NB_DATABASE_URL, {
  max: 2,
  idle_timeout: 30,
  connect_timeout: 5,
  onnotice: () => {},
});

/**
 * 用 meet_id 查 nb_meetings JOIN nb_departments，取得 chat_id + dept_id + 部門名稱 + nb_meetings.id
 * 部門歸屬以派發 bot 時寫入的 nb_meetings.department_id 為唯一來源
 * 若 DB 查不到才 fallback 讀 meeting_map.json
 */
async function lookupDeptByMeetId(meetId: string): Promise<{
  chatId: string;
  deptId: string;
  deptName: string;
  nbMeetingId: string;
  source: "db" | "meeting_map_fallback" | "none";
}> {
  if (!meetId) return { chatId: "", deptId: "", deptName: "", nbMeetingId: "", source: "none" };

  // 主路徑：DB lookup（dispatch-source-of-truth）
  try {
    const rows = await nbSql<
      {
        nb_meeting_id: number | null;
        chat_id: string | null;
        dept_id: number | null;
        dept_name: string | null;
      }[]
    >`
      SELECT m.id AS nb_meeting_id,
             d.chat_id AS chat_id,
             m.department_id AS dept_id,
             d.name AS dept_name
      FROM nb_meetings m
      JOIN nb_departments d ON m.department_id = d.id
      WHERE m.meet_id = ${meetId}
      ORDER BY m.id DESC
      LIMIT 1
    `;
    const first = rows[0];
    if (first && first.chat_id) {
      return {
        chatId: first.chat_id,
        deptId: String(first.dept_id ?? ""),
        deptName: first.dept_name ?? "",
        nbMeetingId: String(first.nb_meeting_id ?? ""),
        source: "db",
      };
    }
  } catch (err) {
    log(`NB DB lookup error for meet_id=${meetId}: ${err}`);
  }

  // Fallback：emergency backup（只在 DB 查不到時用，不可作為決策依據）
  try {
    const fs = await import("fs");
    const path = await import("path");
    const mapPath = path.resolve(
      new URL("../config/meeting_map.json", import.meta.url).pathname,
    );
    const raw = fs.readFileSync(mapPath, "utf-8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const v = map[meetId];
    if (typeof v === "string" && v) {
      log(`⚠️  Fallback to meeting_map.json for meet_id=${meetId} → ${v}（DB 查不到，僅供緊急備援）`);
      return { chatId: v, deptId: "", deptName: "", nbMeetingId: "", source: "meeting_map_fallback" };
    }
  } catch (err) {
    log(`meeting_map.json fallback error for meet_id=${meetId}: ${err}`);
  }

  return { chatId: "", deptId: "", deptName: "", nbMeetingId: "", source: "none" };
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
      '完成後把 Action Items 寫入 nb_action_items DB，會議記錄寫入本地 markdown（meeting_agent/records/{部門}/），並透過 TG 發送摘要給團隊。',
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

    // Weekly report trigger
    if (req.method === "POST" && url.pathname === "/hooks/weekly-report") {
      try {
        const chatId = url.searchParams.get("chat_id") || "";
        const department = url.searchParams.get("department") || "";
        const deptId = url.searchParams.get("dept_id") || "";
        log(`Weekly report triggered: chat_id=${chatId} department=${department} dept_id=${deptId}`);

        // 計算上一週的時間範圍（上週一 00:00 ~ 上週日 23:59:59，UTC+8）
        // 觸發時機是每週一早上 9 點，所以「上一週」= 上週一 ~ 上週日
        const content = [
          `📊 週報自動生成觸發`,
          ``,
          `部門：${department} (dept_id=${deptId}, chat_id=${chatId})`,
          ``,
          `請按照 CLAUDE.md「週報處理規則」spawn sub-agent：`,
          `1. 計算上一週的時間範圍（上週一 00:00 ~ 上週日 23:59:59，UTC+8）`,
          `2. 從 nb_meetings 撈該期間 + 部門的會議（含 summary）`,
          `3. 從 nb_action_items 撈該期間新增 / 完成 / 進行中的 Action Items（依負責人聚合）`,
          `4. 產生議題式 markdown 報表（會議列表、Action Items 統計、各負責人工作量、主要議題、待跟進）`,
          `5. INSERT 到 nb_reports（type='weekly', period_start=上週一, period_end=上週日, dept_id, title, content_md, stats_json）`,
          `6. DM Brian (chat_id=1064895221) 報生成完成 + dashboard 連結`,
        ].join("\n");

        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: content,
            meta: { event: "weekly_report", chat_id: chatId, department: department, dept_id: deptId },
          },
        });

        log(`Weekly report notification SENT`);
        return new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        log(`Weekly report error: ${err}`);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Monthly report trigger
    if (req.method === "POST" && url.pathname === "/hooks/monthly-report") {
      try {
        const chatId = url.searchParams.get("chat_id") || "";
        const department = url.searchParams.get("department") || "";
        const deptId = url.searchParams.get("dept_id") || "";
        log(`Monthly report triggered: chat_id=${chatId} department=${department} dept_id=${deptId}`);

        const content = [
          `📊 月報自動生成觸發`,
          ``,
          `部門：${department} (dept_id=${deptId}, chat_id=${chatId})`,
          ``,
          `請按照 CLAUDE.md「月報處理規則」spawn sub-agent：`,
          `1. 計算上個月的時間範圍（上月 1 號 00:00 ~ 上月最後一天 23:59:59，UTC+8）`,
          `2. 從 nb_meetings 撈該期間 + 部門的會議（含 summary）`,
          `3. 從 nb_action_items 撈該期間新增 / 完成 / 進行中的 Action Items（依負責人聚合）`,
          `4. 產生月度議題式 markdown 報表（會議總覽、Action Items 統計、各負責人月度工作量、主要議題、未完成跟進、月度趨勢）`,
          `5. INSERT 到 nb_reports（type='monthly', period_start=上月 1 號, period_end=上月底, dept_id, title, content_md, stats_json）`,
          `6. DM Brian (chat_id=1064895221) 報生成完成 + dashboard 連結`,
        ].join("\n");

        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: content,
            meta: { event: "monthly_report", chat_id: chatId, department: department, dept_id: deptId },
          },
        });

        log(`Monthly report notification SENT`);
        return new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        log(`Monthly report error: ${err}`);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
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
          `請檢查該部門 nb_action_items DB 中的 Action Items：`,
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

    // Calendar upcoming event trigger（calendar-poller 觸發）
    // phase=T-5：5 分鐘前提醒（+ Claude 自排 oneshot cron 做 T-1 雙保險）
    // phase=T-1：1 分鐘前自動加入
    if (req.method === "POST" && url.pathname === "/hooks/calendar-upcoming") {
      try {
        const phaseQuery = url.searchParams.get("phase") || "";
        const body = await req.json().catch(() => ({} as Record<string, unknown>));
        const phase = String(body.phase || phaseQuery || "");
        const eventId = String(body.event_id || "");
        const meetId = String(body.meet_id || "");
        const title = String(body.title || "(無標題)");
        const startTime = String(body.start_time || "");
        const deptId = body.dept_id !== undefined && body.dept_id !== null ? String(body.dept_id) : "";
        const chatId = String(body.chat_id || "");
        const attendees = Array.isArray(body.attendees) ? body.attendees : [];

        if (phase !== "T-5" && phase !== "T-1") {
          return new Response(
            JSON.stringify({ error: "invalid phase（必須是 T-5 或 T-1）" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (!meetId || !eventId) {
          return new Response(
            JSON.stringify({ error: "meet_id / event_id 為必填" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        // 查部門名稱（補資訊用，查不到也不擋）
        let deptName = "";
        if (deptId) {
          try {
            const rows = await nbSql<{ name: string | null }[]>`
              SELECT name FROM nb_departments WHERE id = ${Number(deptId)} LIMIT 1
            `;
            deptName = rows[0]?.name ?? "";
          } catch (err) {
            log(`Calendar upcoming dept lookup error: ${err}`);
          }
        }

        // 起訖時間顯示用（HH:MM，UTC+8）
        let startDisplay = startTime;
        try {
          const d = new Date(startTime);
          if (!Number.isNaN(d.getTime())) {
            // 轉成 UTC+8 顯示
            const local = new Date(d.getTime() + 8 * 60 * 60 * 1000);
            const hh = String(local.getUTCHours()).padStart(2, "0");
            const mm = String(local.getUTCMinutes()).padStart(2, "0");
            startDisplay = `${hh}:${mm}（UTC+8）`;
          }
        } catch {}

        log(
          `Calendar upcoming: phase=${phase} event_id=${eventId} meet_id=${meetId} ` +
            `dept_id=${deptId} dept_name=${deptName} chat_id=${chatId} ` +
            `start=${startTime} attendees=${attendees.length}`,
        );

        const meetUrl = meetId ? `https://meet.google.com/${meetId}` : "";

        const lines: string[] = [
          `🔔 行事曆事件通知（phase=${phase}）`,
          ``,
          `會議 (Meet ID: ${meetId}) 即將開始`,
          `標題：${title}`,
          `時間：${startDisplay}`,
          deptName || deptId
            ? `部門：${deptName || "(未知)"}（dept_id=${deptId || "?"}, chat_id=${chatId || "(未設定)"}）`
            : `⚠️ 部門查無對應，請依 event_id / meet_id 自行確認後處理`,
          `參與者：${attendees.length} 人`,
          ``,
          `⚠️ 部門歸屬規則（嚴格遵守）`,
          `dept_id 永遠取 nb_meetings.department_id 該 row 的值（派發 bot 時寫入的）。`,
          `禁止讀 config/meeting_map.json 做「修正」— 該檔僅供歷史除錯，不可作為決策依據。`,
          `若占位 row 不存在，再依 chat_id 查 nb_departments；不要查 meeting_map.json。`,
          ``,
          `請處理（主 agent 直接做，動作快不需 sub-agent）：`,
          ``,
        ];

        if (phase === "T-5") {
          // 算 T-1 的絕對時間（會議開始時間 - 1 分鐘），轉成 UTC+8 的 cron 表達式
          // 例：start_time=2026-05-19T07:30:00Z → T-1 = 07:29 UTC = 15:29 UTC+8
          //     → cron: "29 15 19 5 *"
          let cronExpr = "<無法計算，請依 start_time 自行算 T-1 絕對時間>";
          try {
            const d = new Date(startTime);
            if (!Number.isNaN(d.getTime())) {
              const tMinus1 = new Date(d.getTime() - 60 * 1000); // T-1
              // 系統時區 UTC+8
              const local = new Date(tMinus1.getTime() + 8 * 60 * 60 * 1000);
              const mm = local.getUTCMinutes();
              const hh = local.getUTCHours();
              const dd = local.getUTCDate();
              const mo = local.getUTCMonth() + 1;
              cronExpr = `${mm} ${hh} ${dd} ${mo} *`;
            }
          } catch {}

          lines.push(
            `- phase=T-5 → 兩件事都要做：`,
            ``,
            `  1) 發提醒到 dept 群組（用 mcp__plugin_telegram_telegram__reply, chat_id=${chatId || "<部門 chat_id>"}）：`,
            `     📅 5 分鐘後會議：${title}`,
            `     時間：${startDisplay}`,
            `     參與者：${attendees.length} 人`,
            meetUrl ? `     🎥 ${meetUrl}` : `     🎥 https://meet.google.com/${meetId}`,
            ``,
            `  2) 排 oneshot cron 做 T-1 雙保險（防 poller 在 T-5 ~ T-1 之間掛掉）：`,
            `     mcp__vexa__set_cron(`,
            `       name="oneshot-join-${eventId}",`,
            `       schedule="${cronExpr}",`,
            `       webhook_path="/hooks/calendar-upcoming?phase=T-1&event_id=${eventId}&meet_id=${meetId}&chat_id=${chatId || ""}&dept_id=${deptId || ""}&title=${encodeURIComponent(title)}&start_time=${encodeURIComponent(startTime)}"`,
            `     )`,
            `     ⚠️ 該 cron 觸發後（你收到 phase=T-1 channel 通知時）自己呼叫 delete_cron(name="oneshot-join-${eventId}") 清掉，避免每天重複 fire`,
          );
        } else {
          // T-1
          lines.push(
            `- phase=T-1 → 兩件事：`,
            ``,
            `  1) 呼叫 mcp__vexa__join_meeting(meet_id="${meetId}", chat_id="${chatId || "<部門 chat_id>"}", bot_name="NoirsBoxes 會議助理")`,
            `     （join_meeting 會自動觸發 Recap 流程，不需要額外發訊息）`,
            ``,
            `  2) 如果這次 T-1 是從 T-5 排的 oneshot cron 過來的，呼叫 mcp__vexa__delete_cron(name="oneshot-join-${eventId}") 清掉那個 cron`,
            `     （查 list_crons() 看到 oneshot-join-${eventId} 才需要刪，沒有就跳過）`,
          );
        }

        lines.push(
          ``,
          `- 失敗 → 用 mcp__plugin_telegram_telegram__reply DM Brian (chat_id=1064895221) 報告錯誤，不重試。`,
        );

        const content = lines.join("\n");

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              event: "calendar.upcoming",
              phase,
              event_id: eventId,
              meet_id: meetId,
              title,
              start_time: startTime,
              dept_id: deptId,
              dept_name: deptName,
              chat_id: chatId,
              attendees_count: String(attendees.length),
            },
          },
        });

        log(`Calendar upcoming notification SENT for event_id=${eventId} phase=${phase}`);
        return new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        log(`Calendar upcoming error: ${err}`);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Local recording completed webhook
    // 由 dashboard_api 的 /api/recordings 處理完 speaches 轉錄後觸發
    if (req.method === "POST" && url.pathname === "/hooks/local-recording-completed") {
      try {
        const body = await req.json();
        const meetId = String(body.meet_id || "");
        const deptId = body.dept_id;
        const title = String(body.title || "");
        const transcript = String(body.transcript || "");
        const duration = body.duration;

        log(
          `Local recording completed: meet_id=${meetId} dept_id=${deptId} ` +
          `title="${title}" duration=${duration ?? "?"}s transcript_len=${transcript.length}`,
        );

        const content = [
          `🎙️ 本地錄音完成`,
          ``,
          `本地錄音 (Meet ID: ${meetId}) 已完成轉錄。`,
          `部門：dept_id=${deptId ?? "?"}, 時長：${duration ?? "?"}s`,
          `標題：${title}`,
          ``,
          `⚠️ 部門歸屬規則（嚴格遵守）`,
          `dept_id 永遠取 nb_meetings.department_id 該 row 的值（派發 / 錄音建立時寫入的）。`,
          `禁止讀 config/meeting_map.json 做「修正」— 該檔僅供歷史除錯，不可作為決策依據。`,
          `若占位 row 不存在，再依 chat_id 查 nb_departments；不要查 meeting_map.json。`,
          ``,
          `⚠️ 請用 Agent tool 生成 sub-agent 處理，主 agent 保持空閒接收其他請求。`,
          ``,
          `Sub-agent 執行步驟：`,
          `1. 用新版議題式 prompt 從附帶的逐字稿產生摘要 + Action Items（MMDD_N 編號）`,
          `2. UPSERT nb_meetings（依 meet_id 查自己的 row）：`,
          `   SELECT id, department_id FROM nb_meetings`,
          `   WHERE meet_id='${meetId}' AND status IN ('等待加入','會議進行中','逐字稿處理中')`,
          `   ORDER BY id DESC LIMIT 1;`,
          `   - 找到 → UPDATE SET status='completed', title=正式標題, summary=議題式摘要,`,
          `     end_time=NOW(), duration_minutes=${duration ? Math.round(duration / 60) : "null"},`,
          `     transcript_md_path=...（記得保留 source='local-recording'）`,
          `     ❗ 不要動 department_id，建立時寫入的就是正確的`,
          `   - 沒找到 → INSERT 新 row（兼容歷史 / 手動加入）`,
          `3. 寫本地 markdown 到 records/{部門}/MMDD_{標題}_${meetId}.md`,
          `   - 含 metadata、議題式摘要、Action Items、完整逐字稿`,
          `4. 自動更新既有 Action Items（依本場會議內容判斷）`,
          ``,
          `   - 查出本部門所有「未開始 / 進行中」的 Action Items：`,
          `     SELECT code, description, assignee, status, due_date, notes`,
          `     FROM nb_action_items`,
          `     WHERE department_id = ${deptId ?? "<dept_id>"} AND status IN ('未開始', '進行中')`,
          `     ORDER BY code;`,
          ``,
          `   - 依本場會議逐字稿與摘要，判斷哪些既有 AI 需要更新。允許的更新類型：`,
          `     a) status → '已完成'（會議內容明確表達該項已完成）`,
          `     b) due_date → 新日期（會議內討論到新截止時間）`,
          `     c) notes → 在原 notes 後 append 補充（本次討論到的新進度 / 細節）`,
          `     d) assignee → 新負責人（會議內明確改派）`,
          ``,
          `   - 不允許的更新：`,
          `     ❌ 改寫 description（整段重寫）`,
          `     ❌ 刪除整筆 AI`,
          `     ❌ 改 priority`,
          ``,
          `   - 判斷原則：必須有明確依據才更新；隱喻或上下文不清楚就不動。寧可漏更新，不要誤更新。`,
          ``,
          `   - 每筆更新都用：`,
          `     UPDATE nb_action_items`,
          `     SET <欄位> = <新值>, updated_at = NOW()`,
          `     WHERE code = '<MMDD_N>' AND department_id = ${deptId ?? "<dept_id>"};`,
          ``,
          `   - 記下「本次自動更新了哪些 AI、改了什麼、為什麼」，在最終摘要訊息中一起回報。`,
          `5. 用 append_action_items(dept="<部門名稱>" 或 chat_id="<群組 chat_id>", items=[...]) 寫入 nb_action_items DB`,
          `6. 用 mcp__plugin_telegram_telegram__reply 發新訊息 DM Brian (chat_id=1064895221) 帶完整摘要 + Dashboard 連結（觸發推撥）`,
          `   ⚠️ 本地錄音不走 TG 群組，只 DM Brian`,
          `   - 若步驟 5 有自動更新既有 AI，在摘要訊息中加入下列區塊（0 項就不顯示）：`,
          `     🔄 本場會議自動更新了 N 項既有 Action Items：`,
          `     • <code> 「<desc 前 15 字>」 — <欄位>: <舊值> → <新值>（依據：<簡短原因>）`,
          `     • ...`,
          ``,
          `=== 逐字稿 ===`,
          transcript || "(無內容)",
        ].join("\n");

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: content,
            meta: {
              event: "local_recording_completed",
              meet_id: meetId,
              dept_id: String(deptId ?? ""),
              title: title,
              duration: String(duration ?? ""),
            },
          },
        });

        log(`Local recording notification SENT for meet_id=${meetId}`);
        return new Response(JSON.stringify({ status: "accepted" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        log(`Local recording webhook error: ${err}`);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
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

        // 會議實際時長（分鐘）— 用 Vexa 回報的 start/end 算，嵌進 sub-agent 指令。
        // 不能讓 sub-agent 用 NOW() 當 end_time，因為它跑完已是會議結束數分鐘後，會把處理時間算進時長。
        let durationMin: number | null = null;
        if (startTime && endTime) {
          const s = new Date(startTime).getTime();
          const e = new Date(endTime).getTime();
          if (!isNaN(s) && !isNaN(e) && e > s) durationMin = Math.round((e - s) / 60000);
        }

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

        // 立刻把 nb_meetings 占位 row 的 status 從「等待加入 / 會議進行中」改為「逐字稿處理中」
        // 讓 Dashboard 在 sub-agent 還沒跑完前能顯示更精確的狀態
        // 接受「等待加入」是因為會議可能在 bot 還沒被 admit 就結束（host 取消、未開啟等）
        if (nativeMeetingId) {
          try {
            const updated = await sql`
              UPDATE nb_meetings
              SET status = '逐字稿處理中'
              WHERE meet_id = ${nativeMeetingId} AND status IN ('等待加入', '會議進行中')
              RETURNING id
            `;
            log(`Status transition: meet_id=${nativeMeetingId} → 逐字稿處理中 (rows=${updated.length})`);
          } catch (err) {
            log(`Status transition error for ${nativeMeetingId}: ${err}`);
          }
        }

        // 部門歸屬：以 nb_meetings.department_id（派發時寫入）為唯一來源
        // ❌ 禁止讀 meeting_map.json 做「修正」，該檔僅供 DB 查不到時的緊急備援
        const deptInfo = await lookupDeptByMeetId(nativeMeetingId);
        log(
          `Dept lookup for meet_id=${nativeMeetingId}: ` +
          `chat_id=${deptInfo.chatId || "(empty)"} dept_id=${deptInfo.deptId || "(empty)"} ` +
          `dept_name=${deptInfo.deptName || "(empty)"} source=${deptInfo.source}`,
        );

        // 按官方格式推 channel notification
        // Option B：channel 訊息只露出 meet_id（Google Meet code），不暴露任何 numeric ID
        // Sub-agent 內部需要 numeric ID 時自己查 DB：
        //   - Vexa 內部 id：SELECT id FROM meetings WHERE platform_specific_id=? ORDER BY id DESC LIMIT 1
        //   - nb_meetings.id：SELECT id FROM nb_meetings WHERE meet_id=? AND status IN ('等待加入','會議進行中','逐字稿處理中') ORDER BY id DESC LIMIT 1
        const content = [
          `🔔 會議結束通知`,
          ``,
          `會議 (Meet ID: ${nativeMeetingId}) 已結束。`,
          deptInfo.chatId
            ? `部門：${deptInfo.deptName || "(未知)"}（dept_id=${deptInfo.deptId || "?"}, chat_id=${deptInfo.chatId}）`
            : `⚠️ 部門查無對應（DB 與 meeting_map.json 都沒命中），請依 meet_id 重新確認後處理`,
          ``,
          `⚠️ 部門歸屬規則（嚴格遵守）`,
          `dept_id 永遠取 nb_meetings.department_id 該 row 的值（派發 bot 時寫入的）。`,
          `禁止讀 config/meeting_map.json 做「修正」— 該檔僅供歷史除錯，不可作為決策依據。`,
          `若占位 row 不存在，再依 chat_id 查 nb_departments；不要查 meeting_map.json。`,
          ``,
          `⚠️ 請用 Agent tool 生成 sub-agent 處理，主 agent 保持空閒接收其他請求。`,
          ``,
          `Sub-agent 執行步驟：`,
          `1. 查 Vexa 內部 meeting id（summarize_meeting 需要 numeric id）：`,
          `   docker exec vexa-postgres-1 psql -U postgres -d vexa -tAc "\\`,
          `     SELECT id FROM meetings WHERE platform_specific_id='${nativeMeetingId}' ORDER BY id DESC LIMIT 1;"`,
          `   然後呼叫 mcp__vexa__summarize_meeting(meeting_id=<查到的 id>) 取得逐字稿`,
          `2. 用新版議題式 prompt 產生摘要和 Action Items（MMDD_N 編號）`,
          `3. UPSERT nb_meetings（依 meet_id 查自己的 row）：`,
          `   SELECT id, department_id FROM nb_meetings`,
          `   WHERE meet_id='${nativeMeetingId}' AND status IN ('等待加入','會議進行中','逐字稿處理中')`,
          `   ORDER BY id DESC LIMIT 1;`,
          `   - 找到 → UPDATE SET title=正式標題, status='completed',`,
          `     end_time=${endTime ? `'${endTime}'` : "NOW()"},  ← 用 Vexa 回報的實際結束時間，不要用 NOW()（sub-agent 跑完已是數分鐘後，會灌水）`,
          `     duration_minutes=${durationMin !== null ? durationMin : "ROUND(EXTRACT(EPOCH FROM (<上面的 end_time> - start_time))/60)"},  ← 一定要寫，否則 Dashboard 顯示不出時長`,
          `     summary=議題式摘要, transcript_md_path=...`,
          `     ❗ 不要動 department_id，派發時寫入的就是正確的`,
          `   - 沒找到 → INSERT 新 row（兼容歷史 / 手動加入），department_id 依 chat_id 查 nb_departments`,
          `     一併寫 start_time=${startTime ? `'${startTime}'` : "<會議開始時間>"}, end_time=${endTime ? `'${endTime}'` : "NOW()"}, duration_minutes=${durationMin !== null ? durationMin : "<(end-start)/60 取整>"}`,
          `4. 自動更新既有 Action Items（依本場會議內容判斷）`,
          ``,
          `   - 查出本部門所有「未開始 / 進行中」的 Action Items：`,
          `     SELECT code, description, assignee, status, due_date, notes`,
          `     FROM nb_action_items`,
          `     WHERE department_id = ${deptInfo.deptId || "<dept_id>"} AND status IN ('未開始', '進行中')`,
          `     ORDER BY code;`,
          ``,
          `   - 依本場會議逐字稿與摘要，判斷哪些既有 AI 需要更新。允許的更新類型：`,
          `     a) status → '已完成'（會議內容明確表達該項已完成）`,
          `     b) due_date → 新日期（會議內討論到新截止時間）`,
          `     c) notes → 在原 notes 後 append 補充（本次討論到的新進度 / 細節）`,
          `     d) assignee → 新負責人（會議內明確改派）`,
          ``,
          `   - 不允許的更新：`,
          `     ❌ 改寫 description（整段重寫）`,
          `     ❌ 刪除整筆 AI`,
          `     ❌ 改 priority`,
          ``,
          `   - 判斷原則：必須有明確依據才更新；隱喻或上下文不清楚就不動。寧可漏更新，不要誤更新。`,
          ``,
          `   - 每筆更新都用：`,
          `     UPDATE nb_action_items`,
          `     SET <欄位> = <新值>, updated_at = NOW()`,
          `     WHERE code = '<MMDD_N>' AND department_id = ${deptInfo.deptId || "<dept_id>"};`,
          ``,
          `   - 記下「本次自動更新了哪些 AI、改了什麼、為什麼」，在最終摘要訊息中一起回報。`,
          `5. 用 append_action_items(chat_id="${deptInfo.chatId || "<部門 chat_id>"}", items=[...]) 寫入 nb_action_items DB`,
          `6. 寫本地 markdown 到 records/{部門}/MMDD_{標題}_${nativeMeetingId}.md`,
          `   （含 metadata、議題式摘要、Action Items、完整逐字稿；自動更新 nb_meetings.summary + transcript_md_path）`,
          `7. 用 mcp__plugin_telegram_telegram__reply 發完整摘要 + Excel 附件到 dept 群組（觸發推撥）`,
          `   - Excel 從 dashboard_api /api/action-items/export.xlsx 下載`,
          `   - 若步驟 4 有自動更新既有 AI，在摘要訊息中加入下列區塊（0 項就不顯示）：`,
          `     🔄 本場會議自動更新了 N 項既有 Action Items：`,
          `     • <code> 「<desc 前 15 字>」 — <欄位>: <舊值> → <新值>（依據：<簡短原因>）`,
          `     • ...`,
        ].join("\n");

        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: content,
            meta: {
              event: eventType,
              // Option B：對外只暴露 meet_id；numeric ID 由 sub-agent 自己查 DB
              meet_id: nativeMeetingId,
              platform: platform,
              start_time: startTime,
              end_time: endTime,
              chat_id: deptInfo.chatId,
              dept_id: deptInfo.deptId,
              dept_name: deptInfo.deptName,
              dept_source: deptInfo.source,
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
