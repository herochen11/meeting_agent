import { writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { sql } from "../db";
import { getDeptId, requireDept, type DeptVars } from "../auth";

export const recordingsRoute = new Hono<{ Variables: DeptVars }>();

recordingsRoute.use("/api/recordings", requireDept);

const SPEACHES_URL =
  process.env.SPEACHES_URL ?? "http://localhost:8020";
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ?? "http://localhost:8901";
const SPEACHES_MODEL =
  process.env.SPEACHES_MODEL ?? "Systran/faster-whisper-large-v3";

/**
 * 接收瀏覽器錄音檔，存暫存路徑，立即回應；
 * 背景非同步上傳 speaches 轉錄 → 觸發 webhook 進入 sub-agent 流程。
 */
recordingsRoute.post("/api/recordings", async (c) => {
  const deptId = getDeptId(c);

  // 接收 multipart/form-data 音檔
  let body: Record<string, string | File>;
  try {
    body = (await c.req.parseBody()) as Record<string, string | File>;
  } catch (err) {
    return c.json(
      { error: `multipart 解析失敗：${(err as Error).message}` },
      400,
    );
  }

  const audioFile = body["audio"];
  if (!audioFile || typeof audioFile === "string") {
    return c.json({ error: "缺少 audio 檔" }, 400);
  }

  const rawTitle = typeof body["title"] === "string" ? body["title"].trim() : "";
  const title =
    rawTitle.length > 0
      ? rawTitle
      : `本地錄音 ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  // 暫存音檔（用 timestamp 區分）
  const ts = Date.now();
  const tmpPath = `/tmp/recording_${ts}.webm`;
  const buffer = await audioFile.arrayBuffer();
  await writeFile(tmpPath, new Uint8Array(buffer));

  // fake meet_id（用 timestamp 區分，標明是本地錄音）
  const meetId = `local-${ts}`;

  // INSERT nb_meetings 占位（status='逐字稿處理中'，Dashboard 立刻看得到）
  await sql`
    INSERT INTO nb_meetings
      (department_id, title, meet_id, platform, status, start_time, source)
    VALUES
      (${deptId}, ${title}, ${meetId}, '本地錄音', '逐字稿處理中', NOW(), 'local-recording')
  `;

  const mimeType =
    audioFile.type && audioFile.type.length > 0
      ? audioFile.type
      : "audio/webm";

  // 非同步上傳到 speaches 轉錄
  // 注意：在 Bun 內這個 IIFE 會繼續執行，主請求已回應
  void (async () => {
    try {
      const form = new FormData();
      const audioBlob = new Blob([buffer], { type: mimeType });
      form.append("file", audioBlob, "recording.webm");
      form.append("model", SPEACHES_MODEL);
      form.append("language", "zh");
      form.append("vad_filter", "true");
      form.append("response_format", "verbose_json");

      const res = await fetch(`${SPEACHES_URL}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `speaches 回應錯誤 (${res.status}): ${detail.slice(0, 300)}`,
        );
      }

      const transcribeData = (await res.json()) as {
        text?: string;
        duration?: number;
        [key: string]: unknown;
      };

      // 觸發 webhook 進入 sub-agent 流程
      const webhookRes = await fetch(
        `${WEBHOOK_URL}/hooks/local-recording-completed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meet_id: meetId,
            dept_id: deptId,
            title: title,
            transcript: transcribeData.text ?? "",
            duration: transcribeData.duration ?? null,
          }),
        },
      );

      if (!webhookRes.ok) {
        console.warn(
          `[recordings] webhook 通知失敗 (${webhookRes.status}) for meet_id=${meetId}`,
        );
      }
    } catch (err) {
      console.error(
        `[recordings] 處理失敗 meet_id=${meetId}:`,
        (err as Error).message,
      );
      // 更新 nb_meetings 為 failed
      try {
        await sql`
          UPDATE nb_meetings
          SET status = 'failed'
          WHERE meet_id = ${meetId}
        `;
      } catch (updateErr) {
        console.error(
          `[recordings] 更新 failed 狀態失敗 meet_id=${meetId}:`,
          (updateErr as Error).message,
        );
      }
    }
  })();

  // 立刻回應
  return c.json({
    success: true,
    meet_id: meetId,
    message: "錄音已收到，處理中（約 1-3 分鐘）",
  });
});
