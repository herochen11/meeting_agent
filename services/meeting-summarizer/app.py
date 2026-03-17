"""
Meeting Summarizer — Post-meeting webhook handler.
Triggered by Vexa's POST_MEETING_HOOKS when a meeting completes.
Generates: Summary, Meeting Minutes, Action Items using Groq LLM.
Stores results in the meeting's `data` JSON field.
"""

import os
import json
import logging
from datetime import datetime
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx
import asyncpg

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("meeting-summarizer")

app = FastAPI(title="Meeting Summarizer")

# --- Config ---
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"

DB_HOST = os.getenv("DB_HOST", "postgres")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_NAME = os.getenv("DB_NAME", "vexa")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASS = os.getenv("DB_PASS", "vexa_dev_password")

SYSTEM_PROMPT = """你是專業的會議記錄助手。根據以下會議逐字稿，產生結構化的會議記錄。

請用繁體中文輸出，格式如下：

## 📋 會議摘要 (Summary)
用 3-5 句話概述本次會議的重點。

## 📝 會議記錄 (Meeting Minutes)
按時間順序列出會議中討論的主要議題和決議：
- 議題 1：...
  - 討論內容
  - 決議/結論
- 議題 2：...

## ✅ 執行項目 (Action Items)
列出所有需要後續執行的事項：
- [ ] 項目描述 — 負責人（如果有提到）— 期限（如果有提到）

## 💡 重要決策 (Key Decisions)
列出會議中做出的重要決策。

注意事項：
- 如果逐字稿是中文，用繁體中文輸出
- 如果逐字稿是英文，用英文輸出，但格式標題用中英雙語
- 忽略無意義的填充語（嗯、啊、那個）
- 如果提到具體人名，保留原名
- 如果逐字稿內容太短或無實質內容，誠實說明
"""


async def get_db_pool():
    """Get or create database connection pool."""
    if not hasattr(app.state, "db_pool") or app.state.db_pool is None:
        app.state.db_pool = await asyncpg.create_pool(
            host=DB_HOST, port=DB_PORT, database=DB_NAME,
            user=DB_USER, password=DB_PASS, min_size=1, max_size=3
        )
    return app.state.db_pool


async def get_transcripts(meeting_id: int) -> list[dict]:
    """Fetch all transcription segments for a meeting."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT start_time, end_time, text, speaker, language
               FROM transcriptions
               WHERE meeting_id = $1
               ORDER BY start_time ASC""",
            meeting_id
        )
        return [dict(r) for r in rows]


async def update_meeting_data(meeting_id: int, summary_data: dict):
    """Store summary in meeting's data JSON field."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        # Merge with existing data
        row = await conn.fetchrow(
            "SELECT data FROM meetings WHERE id = $1", meeting_id
        )
        existing = json.loads(row["data"]) if row and row["data"] else {}
        existing["ai_summary"] = summary_data
        existing["ai_summary_generated_at"] = datetime.utcnow().isoformat()
        existing["ai_summary_model"] = GROQ_MODEL
        await conn.execute(
            "UPDATE meetings SET data = $1::jsonb, updated_at = NOW() WHERE id = $2",
            json.dumps(existing), meeting_id
        )


def format_transcript(segments: list[dict]) -> str:
    """Format transcript segments into readable text."""
    lines = []
    for seg in segments:
        speaker = seg.get("speaker") or "Unknown"
        text = seg.get("text", "").strip()
        start = seg.get("start_time", 0)
        if text:
            minutes = int(float(start) // 60)
            seconds = int(float(start) % 60)
            lines.append(f"[{minutes:02d}:{seconds:02d}] {speaker}: {text}")
    return "\n".join(lines)


async def generate_summary(transcript_text: str) -> str:
    """Call Groq LLM to generate meeting summary."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            GROQ_API_URL,
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": f"以下是會議逐字稿：\n\n{transcript_text}"},
                ],
                "temperature": 0.3,
                "max_tokens": 4096,
            }
        )
        response.raise_for_status()
        result = response.json()
        return result["choices"][0]["message"]["content"]


@app.post("/hooks/meeting-completed")
async def meeting_completed(request: Request):
    """Webhook endpoint called by Vexa bot-manager when a meeting ends."""
    try:
        payload = await request.json()
        meeting_info = payload.get("meeting", {})
        meeting_id = meeting_info.get("id")

        if not meeting_id:
            return JSONResponse({"error": "missing meeting_id"}, status_code=400)

        logger.info(f"Processing meeting {meeting_id} summary...")

        # 1. Fetch transcripts
        segments = await get_transcripts(meeting_id)
        if not segments:
            logger.warning(f"Meeting {meeting_id}: no transcription segments found")
            return JSONResponse({"status": "skipped", "reason": "no_transcripts"})

        # 2. Format transcript
        transcript_text = format_transcript(segments)
        logger.info(f"Meeting {meeting_id}: {len(segments)} segments, {len(transcript_text)} chars")

        # 3. Generate AI summary
        summary_text = await generate_summary(transcript_text)
        logger.info(f"Meeting {meeting_id}: summary generated ({len(summary_text)} chars)")

        # 4. Store in DB
        summary_data = {
            "full_text": summary_text,
            "transcript_segments": len(segments),
            "transcript_chars": len(transcript_text),
        }
        await update_meeting_data(meeting_id, summary_data)

        logger.info(f"Meeting {meeting_id}: summary stored ✅")
        return JSONResponse({
            "status": "ok",
            "meeting_id": meeting_id,
            "segments": len(segments),
            "summary_length": len(summary_text),
        })

    except Exception as e:
        logger.exception(f"Failed to process meeting: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/health")
async def health():
    return {"status": "ok", "model": GROQ_MODEL}


@app.on_event("shutdown")
async def shutdown():
    if hasattr(app.state, "db_pool") and app.state.db_pool:
        await app.state.db_pool.close()
