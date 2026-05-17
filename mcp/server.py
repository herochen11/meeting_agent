#!/usr/bin/env python3
"""
Vexa MCP Server + Google Sheets + Cron + Config

Tools:
  Vexa: join_meeting, stop_bot, get_status, get_meetings, get_transcript, summarize_meeting
  Sheets: create_sheet, append_action_items, update_action_item, get_action_items
  Cron: set_cron, list_crons, delete_cron
  Config: get_config, add_department, update_member
"""

import os
import sys
import json
import asyncio
import logging
import subprocess
import httpx
import gspread
import psycopg2
import psycopg2.extras
from google.oauth2.service_account import Credentials as ServiceCredentials
from googleapiclient.discovery import build
from gspread.exceptions import SpreadsheetNotFound, WorksheetNotFound
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr
)
logger = logging.getLogger("vexa-mcp")

# ── Config ────────────────────────────────────────────────────
# 用腳本位置推算專案根目錄，避免 hardcoded 路徑
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)

# 自動載入 .env（不依賴 python-dotenv）
def _load_dotenv():
    env_file = os.path.join(_PROJECT_ROOT, ".env")
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, _, value = line.partition('=')
                    os.environ.setdefault(key.strip(), value.strip())

_load_dotenv()

VEXA_API_KEY   = os.getenv("VEXA_API_KEY", os.getenv("VEXA_USER_API_KEY", ""))
VEXA_API_URL   = os.getenv("VEXA_API_URL", "http://localhost:8056")

GOOGLE_CREDS   = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON",
                           os.path.join(_PROJECT_ROOT, "credentials", "google-service-account.json"))
SHARE_WITH_EMAIL = os.getenv("SHARE_WITH_EMAIL", "mojojo0802@gmail.com")
CONFIG_FILE = os.getenv("CONFIG_FILE",
                        os.path.join(_PROJECT_ROOT, "config", "departments.json"))
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
TG_API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

# PostgreSQL（用 host port，因為 MCP server 跑在 host 不是 container 內）
DB_DSN = os.getenv("DATABASE_URL", "postgres://postgres:postgres@localhost:5458/vexa")

def _db_conn():
    """取得 PostgreSQL connection（RealDictCursor，方便用欄位名取值）"""
    return psycopg2.connect(DB_DSN, cursor_factory=psycopg2.extras.RealDictCursor)

# Google Sheets headers
SHEET_HEADERS = ["編號", "任務描述", "負責人", "優先級", "狀態", "預計完成時間", "來源會議", "會議日期", "備註"]

server = Server("vexa")

# ── Config 讀寫 ───────────────────────────────────────

def _read_config() -> dict:
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"departments": [], "members": []}

def _write_config(config: dict) -> bool:
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False

MEETING_MAP_FILE = os.path.join(_PROJECT_ROOT, "config", "meeting_map.json")

def _read_meeting_map() -> dict:
    try:
        with open(MEETING_MAP_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _write_meeting_map(mapping: dict) -> bool:
    try:
        with open(MEETING_MAP_FILE, "w") as f:
            json.dump(mapping, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False

# ── Google Sheets Client ──────────────────────────────────────
_gc = None
_docs_service = None

DOCS_SCOPES = [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
]

def get_gc():
    global _gc
    if _gc is None:
        _gc = gspread.service_account(filename=GOOGLE_CREDS)
        logger.info("Google Sheets client initialized")
    return _gc

def get_docs_service():
    global _docs_service
    if _docs_service is None:
        creds = ServiceCredentials.from_service_account_file(GOOGLE_CREDS, scopes=DOCS_SCOPES)
        _docs_service = build('docs', 'v1', credentials=creds)
        logger.info("Google Docs API client initialized")
    return _docs_service


# ── MCP Tools ─────────────────────────────────────────────────

@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        # ── Vexa Tools ──
        types.Tool(
            name="join_meeting",
            description="送 Vexa bot 進入 Google Meet 會議。必須傳入 chat_id 以記錄會議屬於哪個群組（部門隔離用）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "meet_id": {"type": "string", "description": "Google Meet ID 或完整連結"},
                    "chat_id": {"type": "string", "description": "TG 群組 chat_id，用於記錄會議所屬部門"},
                    "bot_name": {"type": "string", "description": "Bot 在會議中顯示的名稱，預設 NoirsBoxes Meeting Bot"}
                },
                "required": ["meet_id", "chat_id"]
            }
        ),
        types.Tool(
            name="stop_bot",
            description="停止進行中的 bot。",
            inputSchema={
                "type": "object",
                "properties": {
                    "meet_id": {"type": "string", "description": "Meet ID，留空停所有"}
                }
            }
        ),
        types.Tool(
            name="get_status",
            description="查詢目前正在運行的 bot 狀態。",
            inputSchema={"type": "object", "properties": {}}
        ),
        types.Tool(
            name="get_meetings",
            description="列出最近幾場會議記錄。傳入 chat_id 只顯示該群組的會議（部門隔離）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "TG 群組 chat_id，只顯示該群組的會議"},
                    "limit": {"type": "integer", "description": "數量，預設 5", "default": 5}
                },
                "required": ["chat_id"]
            }
        ),
        types.Tool(
            name="get_transcript",
            description="取得指定會議的逐字稿。",
            inputSchema={
                "type": "object",
                "properties": {
                    "native_meeting_id": {"type": "string", "description": "Meet 房間 ID"}
                },
                "required": ["native_meeting_id"]
            }
        ),
        types.Tool(
            name="summarize_meeting",
            description="讀取指定會議的逐字稿並準備摘要資料。可以只提供 meeting_id，會自動查出 native_meeting_id。",
            inputSchema={
                "type": "object",
                "properties": {
                    "meeting_id": {"type": "integer", "description": "PostgreSQL meeting ID"},
                    "native_meeting_id": {"type": "string", "description": "Meet 房間 ID（可選，沒提供會自動查詢）"},
                    "start_time": {"type": "string", "description": "會議開始時間"}
                },
                "required": ["meeting_id"]
            }
        ),

        # ── Google Sheets Tools ──
        types.Tool(
            name="create_sheet",
            description="建立新的 Google Sheets（Action Items 表），自動設定表頭並分享給使用者。用於新部門設定。",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Sheet 名稱，如「NoirsBoxes 業務部 Action Items」"},
                    "share_email": {"type": "string", "description": "分享給誰，預設 mojojo0802@gmail.com"}
                },
                "required": ["title"]
            }
        ),
        types.Tool(
            name="init_sheet_headers",
            description="為現有的 Google Sheet 設定 Action Items 表頭。用於 Google MCP 建立的 Sheet 補上標準表頭。",
            inputSchema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string", "description": "Google Sheet ID"}
                },
                "required": ["spreadsheet_id"]
            }
        ),
        types.Tool(
            name="write_doc",
            description="寫入內容到現有的 Google Doc。用於 Google Drive MCP 建立空白 Doc 後填入會議記錄內容。\n\n"
                        "使用流程：\n"
                        "1. 用 Google Drive MCP 的 create_file 建立空白 Google Doc\n"
                        "2. 用 write_doc 寫入內容（摘要 + Action Items + 逐字稿）",
            inputSchema={
                "type": "object",
                "properties": {
                    "doc_id": {"type": "string", "description": "Google Doc ID（從 create_file 回傳的 ID）"},
                    "content": {"type": "string", "description": "要寫入的文字內容（純文字，支援換行）"}
                },
                "required": ["doc_id", "content"]
            }
        ),
        types.Tool(
            name="append_action_items",
            description="把 Action Items 新增到 Google Sheets（append 新行）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string", "description": "Google Sheet ID"},
                    "items": {
                        "type": "array",
                        "description": "Action Items 陣列",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "編號，如 0505_1"},
                                "task": {"type": "string", "description": "任務描述"},
                                "owner": {"type": "string", "description": "負責人"},
                                "priority": {"type": "string", "description": "高/中/低"},
                                "status": {"type": "string", "description": "未開始/進行中/已完成"},
                                "due_date": {"type": "string", "description": "預計完成時間 YYYY-MM-DD"},
                                "source_meeting": {"type": "string", "description": "來源會議 Meet ID"},
                                "meeting_date": {"type": "string", "description": "會議日期 YYYY-MM-DD"},
                                "notes": {"type": "string", "description": "備註"}
                            }
                        }
                    }
                },
                "required": ["spreadsheet_id", "items"]
            }
        ),
        types.Tool(
            name="update_action_item",
            description="更新 Google Sheets 中某個 Action Item 的欄位（狀態、負責人、截止日等）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string", "description": "Google Sheet ID"},
                    "item_id": {"type": "string", "description": "Action Item 編號，如 0505_1"},
                    "updates": {
                        "type": "object",
                        "description": "要更新的欄位",
                        "properties": {
                            "task": {"type": "string"},
                            "owner": {"type": "string"},
                            "priority": {"type": "string"},
                            "status": {"type": "string"},
                            "due_date": {"type": "string"},
                            "notes": {"type": "string"}
                        }
                    }
                },
                "required": ["spreadsheet_id", "item_id", "updates"]
            }
        ),
        types.Tool(
            name="get_action_items",
            description="從 Google Sheets 取得 Action Items 清單。可篩選狀態和負責人。",
            inputSchema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string", "description": "Google Sheet ID"},
                    "status_filter": {"type": "string", "description": "篩選狀態：未開始/進行中/已完成，留空顯示全部"},
                    "owner_filter": {"type": "string", "description": "篩選負責人，留空顯示全部"}
                },
                "required": ["spreadsheet_id"]
            }
        ),

        # ── Cron Tools ──
        types.Tool(
            name="set_cron",
            description="建立或更新一個定時任務。用於設定每日跟催、週報等定期任務。\n\n"
                        "cron 格式：分 時 日 月 週\n"
                        "範例：\n"
                        "  - 每天早上 9 點：0 9 * * *\n"
                        "  - 每天下午 3 點：0 15 * * *\n"
                        "  - 每週五下午 5 點：0 17 * * 5\n"
                        "  - 每小時：0 * * * *\n\n"
                        "webhook 路徑範例：\n"
                        "  - 跟催：/hooks/daily-reminder\n"
                        "  - 週報：/hooks/weekly-report\n"
                        "  - 自訂：/hooks/任意名稱",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "任務名稱，如 daily-reminder、weekly-report"},
                    "schedule": {"type": "string", "description": "Cron 表達式，如 '0 9 * * *'（每天 9:00）。時區為系統時區。"},
                    "webhook_path": {"type": "string", "description": "Webhook 路徑，如 /hooks/daily-reminder"}
                },
                "required": ["name", "schedule", "webhook_path"]
            }
        ),
        types.Tool(
            name="list_crons",
            description="列出所有由系統管理的定時任務（cron jobs）。",
            inputSchema={"type": "object", "properties": {}}
        ),
        types.Tool(
            name="delete_cron",
            description="刪除一個定時任務。",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "要刪除的任務名稱"}
                },
                "required": ["name"]
            }
        ),

        # ── Config Tools ──
        types.Tool(
            name="get_config",
            description="讀取系統設定，包含所有部門對應表和人員對應表。\n"
                        "用於：查詢 chat_id 對應哪個部門、查詢部門的 Sheet ID 和 Drive 資料夾 ID、查詢人員的 TG Username。",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "可選，用 chat_id 篩選特定部門"}
                }
            }
        ),
        types.Tool(
            name="add_department",
            description="新增一個部門到設定檔。用於新群組設定時註冊部門資訊。",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "TG 群組 chat_id"},
                    "name": {"type": "string", "description": "部門名稱"},
                    "sheet_id": {"type": "string", "description": "Google Sheet ID"},
                    "drive_folder_id": {"type": "string", "description": "Google Drive 資料夾 ID"}
                },
                "required": ["chat_id", "name", "sheet_id", "drive_folder_id"]
            }
        ),
        types.Tool(
            name="update_member",
            description="更新人員對應表。用於註冊或更新人員的 TG Username、逐字稿名字等。",
            inputSchema={
                "type": "object",
                "properties": {
                    "system_name": {"type": "string", "description": "系統名稱，如 Brian、Ron"},
                    "tg_username": {"type": "string", "description": "TG Username，如 @brianchen0314"},
                    "transcript_names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "逐字稿可能出現的名字列表"
                    }
                },
                "required": ["system_name"]
            }
        ),

        # ── Telegram 通知 Tools ──
        types.Tool(
            name="send_processing",
            description="發送「處理中」提示訊息到 TG 群組。收到用戶訊息後立即呼叫，讓用戶知道 bot 正在處理。\n"
                        "回傳 message_id，處理完成後用 Claude Code 內建的 edit_message 更新狀態。",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string", "description": "TG 群組 chat_id"},
                    "text": {"type": "string", "description": "提示訊息，預設『⏳ 處理中...』"}
                },
                "required": ["chat_id"]
            }
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    try:
        # Vexa tools
        if name == "join_meeting":
            result = await _join_meeting(arguments.get("meet_id", ""), arguments.get("chat_id", ""), arguments.get("bot_name", "NoirsBoxes 會議助理"))
        elif name == "stop_bot":
            result = await _stop_bot(arguments.get("meet_id", ""))
        elif name == "get_status":
            result = await _get_status()
        elif name == "get_meetings":
            result = await _get_meetings(arguments.get("chat_id", ""), arguments.get("limit", 5))
        elif name == "get_transcript":
            result = await _get_transcript(arguments.get("native_meeting_id", ""))
        elif name == "summarize_meeting":
            result = await _summarize_meeting(
                arguments.get("meeting_id"),
                arguments.get("native_meeting_id", ""),
                arguments.get("start_time", "")
            )
        # Google Sheets tools
        elif name == "create_sheet":
            result = await asyncio.to_thread(
                _create_sheet, arguments.get("title", ""), arguments.get("share_email", SHARE_WITH_EMAIL)
            )
        elif name == "init_sheet_headers":
            result = await asyncio.to_thread(
                _init_sheet_headers, arguments.get("spreadsheet_id", "")
            )
        elif name == "write_doc":
            result = await asyncio.to_thread(
                _write_doc, arguments.get("doc_id", ""), arguments.get("content", "")
            )
        elif name == "append_action_items":
            result = await asyncio.to_thread(
                _append_action_items, arguments.get("spreadsheet_id", ""), arguments.get("items", [])
            )
        elif name == "update_action_item":
            result = await asyncio.to_thread(
                _update_action_item, arguments.get("spreadsheet_id", ""),
                arguments.get("item_id", ""), arguments.get("updates", {})
            )
        elif name == "get_action_items":
            result = await asyncio.to_thread(
                _get_action_items, arguments.get("spreadsheet_id", ""),
                arguments.get("status_filter", ""), arguments.get("owner_filter", "")
            )
        # Cron tools
        elif name == "set_cron":
            result = await asyncio.to_thread(
                _set_cron, arguments.get("name", ""),
                arguments.get("schedule", ""), arguments.get("webhook_path", "")
            )
        elif name == "list_crons":
            result = await asyncio.to_thread(_list_crons)
        elif name == "delete_cron":
            result = await asyncio.to_thread(_delete_cron, arguments.get("name", ""))
        # Config tools
        elif name == "get_config":
            result = await asyncio.to_thread(_get_config, arguments.get("chat_id", ""))
        elif name == "add_department":
            result = await asyncio.to_thread(
                _add_department, arguments.get("chat_id", ""),
                arguments.get("name", ""), arguments.get("sheet_id", ""),
                arguments.get("drive_folder_id", "")
            )
        elif name == "update_member":
            result = await asyncio.to_thread(
                _update_member, arguments.get("system_name", ""),
                arguments.get("tg_username", ""), arguments.get("transcript_names")
            )
        # Telegram 通知 tools
        elif name == "send_processing":
            result = await _send_processing(
                arguments.get("chat_id", ""),
                arguments.get("text", "⏳ 處理中...")
            )
        else:
            result = f"未知工具：{name}"
        return [types.TextContent(type="text", text=result)]
    except Exception as e:
        return [types.TextContent(type="text", text=f"錯誤：{e}")]


# ── Vexa 工具實作 ─────────────────────────────────────────────

async def _join_meeting(meet_id: str, chat_id: str = "", bot_name: str = "NoirsBoxes Meeting Bot") -> str:
    meet_id = meet_id.strip().lower()
    if "meet.google.com/" in meet_id:
        meet_id = meet_id.split("meet.google.com/")[-1].split("?")[0]
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            f"{VEXA_API_URL}/bots",
            headers={"X-API-Key": VEXA_API_KEY, "Content-Type": "application/json"},
            json={"platform": "google_meet", "native_meeting_id": meet_id, "bot_name": bot_name}
        )
        if r.status_code in (200, 201):
            data = r.json()
            mid  = data.get("meeting_id") or data.get("id")
            # 記錄會議屬於哪個群組（部門隔離）
            if chat_id:
                mapping = _read_meeting_map()
                mapping[meet_id] = str(chat_id)
                _write_meeting_map(mapping)
            return json.dumps({"success": True, "meet_id": meet_id, "meeting_id": mid}, ensure_ascii=False)
        elif r.status_code == 409:
            return json.dumps({"success": False, "reason": f"Bot 已在會議 {meet_id} 中"}, ensure_ascii=False)
        else:
            return json.dumps({"success": False, "status": r.status_code, "detail": r.text[:200]}, ensure_ascii=False)


async def _stop_bot(meet_id: str = "") -> str:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{VEXA_API_URL}/bots/status", headers={"X-API-Key": VEXA_API_KEY})
        if r.status_code != 200:
            return json.dumps({"error": f"無法取得狀態 {r.status_code}"}, ensure_ascii=False)
        bots = r.json().get("running_bots", [])
        if not bots:
            return json.dumps({"message": "目前沒有進行中的 bot"}, ensure_ascii=False)
        targets = [b for b in bots if meet_id in b.get("native_meeting_id", "")] if meet_id else bots
        stopped, failed = [], []
        for b in targets:
            mid = b.get("native_meeting_id", "")
            r2  = await client.delete(f"{VEXA_API_URL}/bots/google_meet/{mid}", headers={"X-API-Key": VEXA_API_KEY})
            (stopped if r2.status_code in (200, 202, 204) else failed).append(mid)
        return json.dumps({"stopped": stopped, "failed": failed}, ensure_ascii=False)


async def _get_status() -> str:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{VEXA_API_URL}/bots/status", headers={"X-API-Key": VEXA_API_KEY})
        if r.status_code != 200:
            return json.dumps({"error": f"無法取得狀態 {r.status_code}"}, ensure_ascii=False)
        bots = r.json().get("running_bots", [])
        return json.dumps({
            "running_count": len(bots),
            "bots": [{"meet_id": b.get("native_meeting_id"), "status": b.get("normalized_status")} for b in bots]
        }, ensure_ascii=False)


async def _get_meetings(chat_id: str = "", limit: int = 5) -> str:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{VEXA_API_URL}/meetings", headers={"X-API-Key": VEXA_API_KEY})
        if r.status_code != 200:
            return json.dumps({"error": f"無法取得會議列表 {r.status_code}"}, ensure_ascii=False)
        data     = r.json()
        meetings = data.get("meetings", data) if isinstance(data, dict) else data
        meetings = meetings if isinstance(meetings, list) else []

        # 部門隔離：用 meeting_map 過濾該群組的會議
        if chat_id:
            mapping = _read_meeting_map()
            allowed_meet_ids = {mid for mid, cid in mapping.items() if str(cid) == str(chat_id)}
            meetings = [m for m in meetings if m.get("native_meeting_id", "") in allowed_meet_ids]

        meetings = meetings[:limit]
        result   = [{"id": m.get("id"), "native_meeting_id": m.get("native_meeting_id"),
                     "status": m.get("status"),
                     "start_time": m.get("start_time", "")[:16] if m.get("start_time") else None} for m in meetings]
        return json.dumps({"meetings": result}, ensure_ascii=False)


async def _get_transcript(native_meeting_id: str) -> str:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            f"{VEXA_API_URL}/transcripts/google_meet/{native_meeting_id}",
            headers={"X-API-Key": VEXA_API_KEY}
        )
        if r.status_code != 200:
            return json.dumps({"error": f"無法取得逐字稿 {r.status_code}"}, ensure_ascii=False)
        data     = r.json()
        segments = data.get("segments", [])
        lines    = []
        for seg in segments:
            start = seg.get("start", 0)
            m = int(float(start) // 60)
            s = int(float(start) % 60)
            lines.append(f"[{m:02d}:{s:02d}] {seg.get('speaker', '??')}: {seg.get('text', '')}")
        return json.dumps({
            "meeting_id": data.get("id"),
            "native_meeting_id": native_meeting_id,
            "segments_count": len(segments),
            "transcript": "\n".join(lines)
        }, ensure_ascii=False)


async def _summarize_meeting(meeting_id: int, native_meeting_id: str = "", start_time: str = "") -> str:
    # 如果沒有 native_meeting_id，從 meetings API 查詢
    if not native_meeting_id:
        meetings_result = await _get_meetings("", 20)
        meetings_data = json.loads(meetings_result)
        for m in meetings_data.get("meetings", []):
            if m.get("id") == meeting_id:
                native_meeting_id = m.get("native_meeting_id", "")
                if not start_time:
                    start_time = m.get("start_time", "")
                break
        if not native_meeting_id:
            return json.dumps({"error": f"找不到 meeting_id={meeting_id} 的 native_meeting_id"}, ensure_ascii=False)

    transcript_result = await _get_transcript(native_meeting_id)
    transcript_data   = json.loads(transcript_result)
    if "error" in transcript_data:
        return transcript_result
    return json.dumps({
        "status":            "ready_for_summary",
        "meeting_id":        meeting_id,
        "native_meeting_id": native_meeting_id,
        "start_time":        start_time,
        "segments_count":    transcript_data.get("segments_count", 0),
        "transcript":        transcript_data.get("transcript", ""),
        "instruction":       (
            "請根據以上逐字稿產生：\n\n"
            "1. 會議摘要（8-15 句）\n"
            "   - 涵蓋所有主要討論議題與決策結論，不只列結論，也要交代背景和討論脈絡\n"
            "   - 重要數字、日期、承諾事項必須保留\n\n"
            "2. Action Items（編號 MMDD_N）\n"
            "   - 任務描述必須具體明確，包含：做什麼、為什麼、預期產出是什麼\n"
            "   - ❌ 模糊：「處理韌體問題」\n"
            "   - ✅ 具體：「修復 PD-35 韌體 v2.1 在快充模式下的斷電問題，完成後提供測試報告給 Brian 確認」\n"
            "   - 如果逐字稿中有提到具體的規格、數字、對象，務必寫進任務描述\n"
            "   - 每個 item 包含：負責人、截止日、優先級（高/中/低）\n\n"
            "然後把 Action Items 寫入 Google Sheets（用 append_action_items），\n"
            "在 Google Drive 建立會議記錄，並透過 TG 發送摘要給團隊。\n\n"
            "⚠️ 語言處理：此會議以中文進行。逐字稿中如有整句英文，是語音辨識誤判（說中文但夾雜英文單字導致整句被轉為英文）。\n"
            "寫入 Google Doc 時，請將這些英文段落翻譯為中文。產品型號、技術術語可保留英文原文。"
        )
    }, ensure_ascii=False)


# ── Google Sheets 工具實作 ─────────────────────────────────────

def _create_sheet(title: str, share_email: str = "") -> str:
    """建立新的 Google Sheet，設定表頭，分享給使用者"""
    gc = get_gc()
    sh = gc.create(title)

    ws = sh.sheet1
    ws.update('A1:I1', [SHEET_HEADERS])
    # 凍結第一行
    ws.freeze(rows=1)

    # 分享給使用者
    email = share_email or SHARE_WITH_EMAIL
    if email:
        sh.share(email, perm_type='user', role='writer')

    return json.dumps({
        "success": True,
        "spreadsheet_id": sh.id,
        "url": sh.url,
        "title": title,
        "shared_with": email
    }, ensure_ascii=False)


def _init_sheet_headers(spreadsheet_id: str) -> str:
    """為現有的 Sheet 設定 Action Items 表頭"""
    gc = get_gc()
    try:
        sh = gc.open_by_key(spreadsheet_id)
    except Exception as e:
        return json.dumps({"success": False, "error": f"無法開啟 Sheet: {e}"}, ensure_ascii=False)

    ws = sh.sheet1
    ws.update('A1:I1', [SHEET_HEADERS])
    ws.freeze(rows=1)

    return json.dumps({
        "success": True,
        "spreadsheet_id": spreadsheet_id,
        "headers": SHEET_HEADERS,
        "message": "表頭已設定"
    }, ensure_ascii=False)


def _write_doc(doc_id: str, content: str) -> str:
    """寫入內容到現有的 Google Doc"""
    if not doc_id or not content:
        return json.dumps({"success": False, "error": "缺少 doc_id 或 content"}, ensure_ascii=False)

    try:
        service = get_docs_service()

        # 先清空文件內容（如果有的話）
        doc = service.documents().get(documentId=doc_id).execute()
        body_content = doc.get('body', {}).get('content', [])
        if len(body_content) > 1:
            # 有內容，先刪除（保留第一個 paragraph 的 newline）
            end_index = body_content[-1].get('endIndex', 1)
            if end_index > 2:
                requests = [{
                    'deleteContentRange': {
                        'range': {
                            'startIndex': 1,
                            'endIndex': end_index - 1
                        }
                    }
                }]
                service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()

        # 寫入新內容
        requests = [{
            'insertText': {
                'location': {'index': 1},
                'text': content
            }
        }]
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()

        return json.dumps({
            "success": True,
            "doc_id": doc_id,
            "chars_written": len(content),
            "url": f"https://docs.google.com/document/d/{doc_id}/edit"
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


def _next_code(cur, dept_id: int, mmdd: str) -> str:
    """算出某部門在某 MMDD 的下一個 code（MMDD_N）。caller 須提供 cursor。"""
    prefix = f"{mmdd}_"
    cur.execute(
        "SELECT code FROM nb_action_items WHERE department_id = %s AND code LIKE %s",
        (dept_id, prefix + "%"),
    )
    max_n = 0
    for r in cur.fetchall():
        code = r["code"]
        # match MMDD_N where MMDD 完全相等
        try:
            head, _, tail = code.partition("_")
            if head == mmdd:
                n = int(tail)
                if n > max_n:
                    max_n = n
        except (ValueError, AttributeError):
            continue
    return f"{mmdd}_{max_n + 1}"


def _mmdd_from_date(date_str: str) -> str:
    """從 YYYY-MM-DD 取出 MMDD；空值用今天（UTC+8）"""
    if date_str and len(date_str) >= 10:
        # YYYY-MM-DD → MMDD
        return date_str[5:7] + date_str[8:10]
    # fallback：今天（UTC+8）
    import datetime as _dt
    now = _dt.datetime.utcnow() + _dt.timedelta(hours=8)
    return now.strftime("%m%d")


def _append_action_items(spreadsheet_id: str, items: list) -> str:
    """把 Action Items 寫入 DB（主）並 append 到 Sheet（副）。

    每個 item 若沒帶 id，自動產生 code（MMDD_N）。
    若 source_meeting (meet_id) 存在於 nb_meetings，會關聯 meeting_id。
    """
    if not spreadsheet_id:
        return json.dumps({"success": False, "error": "缺少 spreadsheet_id"}, ensure_ascii=False)
    if not items:
        return json.dumps({"success": False, "error": "items 為空"}, ensure_ascii=False)

    # ── DB 主寫 ──
    try:
        conn = _db_conn()
    except Exception as e:
        return json.dumps({"success": False, "error": f"DB 連線失敗: {e}"}, ensure_ascii=False)

    inserted_ids = []
    enriched_items = []  # 帶補齊後的 code，用來寫 Sheet
    try:
        try:
            with conn:
                with conn.cursor() as cur:
                    # 查 department_id
                    cur.execute(
                        "SELECT id, name FROM nb_departments WHERE sheet_id = %s LIMIT 1",
                        (spreadsheet_id,),
                    )
                    dept = cur.fetchone()
                    if not dept:
                        return json.dumps({
                            "success": False,
                            "error": f"找不到對應部門（sheet_id={spreadsheet_id} 未在 nb_departments 登記）"
                        }, ensure_ascii=False)
                    dept_id = dept["id"]

                    # 預先把每 item 補 code（避免後續 INSERT 撞號）
                    # 同一 batch 內遞增當天計數
                    daily_counters = {}  # mmdd -> current max

                    for item in items:
                        code = (item.get("id") or "").strip()
                        if not code:
                            mmdd = _mmdd_from_date(item.get("meeting_date", ""))
                            if mmdd not in daily_counters:
                                # 第一次遇到這個 mmdd，從 DB 算出當前最大值
                                next_c = _next_code(cur, dept_id, mmdd)
                                # next_c = MMDD_N，把 N 拿出來
                                n = int(next_c.split("_")[1])
                                code = next_c
                                daily_counters[mmdd] = n
                            else:
                                daily_counters[mmdd] += 1
                                code = f"{mmdd}_{daily_counters[mmdd]}"

                        # 找 meeting_id（用 meet_id + dept 限定）
                        meeting_id = None
                        source_meet = (item.get("source_meeting") or "").strip()
                        if source_meet:
                            cur.execute(
                                """
                                SELECT id FROM nb_meetings
                                WHERE meet_id = %s AND department_id = %s
                                ORDER BY id DESC LIMIT 1
                                """,
                                (source_meet, dept_id),
                            )
                            mrow = cur.fetchone()
                            if mrow:
                                meeting_id = mrow["id"]

                        description = item.get("task", "") or ""
                        assignee = item.get("owner") or None  # 空字串 → NULL
                        if assignee == "":
                            assignee = None
                        priority = item.get("priority") or "中"
                        status = item.get("status") or "未開始"
                        due_date = item.get("due_date") or None
                        if due_date == "":
                            due_date = None
                        notes = item.get("notes") or None
                        if notes == "":
                            notes = None

                        cur.execute(
                            """
                            INSERT INTO nb_action_items
                              (meeting_id, department_id, code, description,
                               assignee, priority, status, due_date, notes)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                            RETURNING id
                            """,
                            (meeting_id, dept_id, code, description,
                             assignee, priority, status, due_date, notes),
                        )
                        new_id = cur.fetchone()["id"]
                        inserted_ids.append(new_id)

                        # 把補齊後的 item 留給 Sheet 寫入
                        enriched = dict(item)
                        enriched["id"] = code
                        enriched["priority"] = priority
                        enriched["status"] = status
                        enriched_items.append(enriched)
        except Exception as e:
            logger.error(f"DB INSERT 失敗: {e}")
            return json.dumps({"success": False, "error": f"DB INSERT 失敗: {e}"}, ensure_ascii=False)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # ── Sheet 副寫（失敗只 warning） ──
    sheet_appended = False
    sheet_url = None
    sheet_warning = None
    try:
        gc = get_gc()
        sh = gc.open_by_key(spreadsheet_id)
        ws = sh.sheet1
        sheet_url = sh.url

        rows = []
        for item in enriched_items:
            rows.append([
                item.get("id", ""),
                item.get("task", ""),
                item.get("owner", "待確認"),
                item.get("priority", "中"),
                item.get("status", "未開始"),
                item.get("due_date", ""),
                item.get("source_meeting", ""),
                item.get("meeting_date", ""),
                item.get("notes", ""),
            ])

        if rows:
            ws.append_rows(rows, value_input_option='USER_ENTERED')
        sheet_appended = True
    except Exception as e:
        sheet_warning = f"Sheet append 失敗（DB 已成功）: {e}"
        logger.warning(sheet_warning)

    result = {
        "success": True,
        "appended": len(inserted_ids),
        "db_inserted_ids": inserted_ids,
        "codes": [it.get("id") for it in enriched_items],
        "sheet_appended": sheet_appended,
        "spreadsheet_url": sheet_url,
    }
    if sheet_warning:
        result["warning"] = sheet_warning
    return json.dumps(result, ensure_ascii=False)


def _update_action_item(spreadsheet_id: str, item_id: str, updates: dict) -> str:
    """根據編號找到 Action Item 並更新指定欄位。

    流程：DB 主寫 → Sheet 副寫。
      1. DB UPDATE 失敗 → 整個 tool 失敗
      2. DB code 不存在 → 失敗（不寫 Sheet，避免造成不一致）
      3. DB 成功、Sheet 失敗 → 仍視為 success，但 warning
    """
    if not spreadsheet_id or not item_id:
        return json.dumps({"success": False, "error": "缺少 spreadsheet_id 或 item_id"}, ensure_ascii=False)
    if not updates:
        return json.dumps({"success": False, "error": "updates 為空"}, ensure_ascii=False)

    # ── DB 主寫 ──
    db_field_map = {
        "task": "description",
        "owner": "assignee",
        "priority": "priority",
        "status": "status",
        "due_date": "due_date",
        "notes": "notes",
    }

    set_clauses = []
    set_values = []
    db_updated_fields = []
    for field, value in updates.items():
        col = db_field_map.get(field)
        if col is None:
            continue
        # 空字串 due_date 視為 NULL
        if col == "due_date" and (value == "" or value is None):
            set_clauses.append(f"{col} = NULL")
        else:
            set_clauses.append(f"{col} = %s")
            set_values.append(value)
        db_updated_fields.append(f"{field}={value}")

    if not set_clauses:
        return json.dumps({"success": False, "error": "updates 沒有任何可同步欄位"}, ensure_ascii=False)

    set_clauses.append("updated_at = NOW()")

    db_row_id = None
    try:
        conn = _db_conn()
    except Exception as e:
        return json.dumps({"success": False, "error": f"DB 連線失敗: {e}"}, ensure_ascii=False)

    try:
        try:
            with conn:
                with conn.cursor() as cur:
                    # 查 row id（透過 sheet_id 限定部門範圍，避免跨部門同名 code 撞車）
                    cur.execute(
                        """
                        SELECT ai.id
                        FROM nb_action_items ai
                        JOIN nb_departments d ON ai.department_id = d.id
                        WHERE d.sheet_id = %s AND ai.code = %s
                        LIMIT 1
                        """,
                        (spreadsheet_id, item_id),
                    )
                    row = cur.fetchone()
                    if not row:
                        return json.dumps({
                            "success": False,
                            "error": f"找不到對應 Action Item (sheet_id={spreadsheet_id}, code={item_id})"
                        }, ensure_ascii=False)
                    db_row_id = row["id"]

                    # 動態 UPDATE
                    sql = f"UPDATE nb_action_items SET {', '.join(set_clauses)} WHERE id = %s"
                    cur.execute(sql, (*set_values, db_row_id))
        except Exception as e:
            logger.error(f"DB UPDATE 失敗 (item_id={item_id}): {e}")
            return json.dumps({"success": False, "error": f"DB UPDATE 失敗: {e}"}, ensure_ascii=False)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # ── Sheet 副寫（失敗只 warning） ──
    sheet_updated = False
    sheet_row = None
    sheet_warning = None
    try:
        gc = get_gc()
        sh = gc.open_by_key(spreadsheet_id)
        ws = sh.sheet1

        try:
            cell = ws.find(item_id, in_column=1)
        except Exception as find_err:
            sheet_warning = f"Sheet 找不到編號 {item_id}: {find_err}"
            logger.warning(sheet_warning)
        else:
            sheet_row = cell.row
            # 欄位對應：A=編號 B=任務 C=負責人 D=優先級 E=狀態 F=截止日 G=來源會議 H=會議日期 I=備註
            col_map = {
                "task": 2, "owner": 3, "priority": 4, "status": 5,
                "due_date": 6, "source_meeting": 7, "meeting_date": 8, "notes": 9
            }
            for field, value in updates.items():
                col = col_map.get(field)
                if col:
                    ws.update_cell(sheet_row, col, value)
            sheet_updated = True
    except Exception as e:
        sheet_warning = f"Sheet 更新失敗（DB 已成功）: {e}"
        logger.warning(sheet_warning)

    result = {
        "success": True,
        "item_id": item_id,
        "db_row_id": db_row_id,
        "row": sheet_row,
        "updated": db_updated_fields,
        "db_updated": True,
        "sheet_updated": sheet_updated,
    }
    if sheet_warning:
        result["warning"] = sheet_warning
    return json.dumps(result, ensure_ascii=False)


def _get_action_items(spreadsheet_id: str, status_filter: str = "", owner_filter: str = "") -> str:
    """讀取 Action Items，可篩選狀態和負責人"""
    gc = get_gc()
    sh = gc.open_by_key(spreadsheet_id)
    ws = sh.sheet1

    all_records = ws.get_all_records()

    items = []
    for record in all_records:
        # 篩選
        if status_filter and record.get("狀態", "") != status_filter:
            continue
        if owner_filter and owner_filter not in record.get("負責人", ""):
            continue
        items.append({
            "id":             record.get("編號", ""),
            "task":           record.get("任務描述", ""),
            "owner":          record.get("負責人", ""),
            "priority":       record.get("優先級", ""),
            "status":         record.get("狀態", ""),
            "due_date":       record.get("預計完成時間", ""),
            "source_meeting": record.get("來源會議", ""),
            "meeting_date":   record.get("會議日期", ""),
            "notes":          record.get("備註", ""),
        })

    return json.dumps({
        "total": len(items),
        "items": items,
        "spreadsheet_url": sh.url
    }, ensure_ascii=False)


# ── Config 工具實作 ────────────────────────────────────

def _get_config(chat_id: str = "") -> str:
    """讀取設定，可用 chat_id 篩選特定部門"""
    config = _read_config()

    if chat_id:
        dept = next((d for d in config.get("departments", []) if str(d.get("chat_id")) == str(chat_id)), None)
        if dept:
            return json.dumps({"department": dept, "members": config.get("members", [])}, ensure_ascii=False)
        else:
            return json.dumps({"error": f"找不到 chat_id={chat_id} 的部門", "members": config.get("members", [])}, ensure_ascii=False)

    return json.dumps(config, ensure_ascii=False)


def _add_department(chat_id: str, name: str, sheet_id: str, drive_folder_id: str) -> str:
    """新增部門"""
    if not chat_id or not name:
        return json.dumps({"success": False, "error": "缺少 chat_id 或 name"}, ensure_ascii=False)

    config = _read_config()
    departments = config.get("departments", [])

    # 檢查是否已存在
    existing = next((d for d in departments if str(d.get("chat_id")) == str(chat_id)), None)
    if existing:
        # 更新現有的
        existing["name"] = name
        existing["sheet_id"] = sheet_id
        existing["drive_folder_id"] = drive_folder_id
        action = "已更新"
    else:
        # 新增
        departments.append({
            "chat_id": str(chat_id),
            "name": name,
            "sheet_id": sheet_id,
            "drive_folder_id": drive_folder_id
        })
        action = "已新增"

    config["departments"] = departments
    if _write_config(config):
        return json.dumps({"success": True, "action": action, "name": name, "chat_id": chat_id}, ensure_ascii=False)
    else:
        return json.dumps({"success": False, "error": "寫入設定檔失敗"}, ensure_ascii=False)


def _update_member(system_name: str, tg_username: str = "", transcript_names: list = None) -> str:
    """更新或新增人員"""
    if not system_name:
        return json.dumps({"success": False, "error": "缺少 system_name"}, ensure_ascii=False)

    config = _read_config()
    members = config.get("members", [])

    existing = next((m for m in members if m.get("system_name") == system_name), None)
    if existing:
        if tg_username:
            existing["tg_username"] = tg_username
        if transcript_names:
            existing["transcript_names"] = transcript_names
        action = "已更新"
    else:
        members.append({
            "system_name": system_name,
            "tg_username": tg_username or "",
            "transcript_names": transcript_names or []
        })
        action = "已新增"

    config["members"] = members
    if _write_config(config):
        return json.dumps({"success": True, "action": action, "system_name": system_name}, ensure_ascii=False)
    else:
        return json.dumps({"success": False, "error": "寫入設定檔失敗"}, ensure_ascii=False)


# ── Cron 工具實作 ─────────────────────────────────────

CRON_TAG = "# vexa-managed:"
WEBHOOK_BASE = "http://localhost:8901"


def _get_current_crontab() -> str:
    """get current crontab content"""
    try:
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        return result.stdout if result.returncode == 0 else ""
    except Exception:
        return ""


def _write_crontab(content: str) -> bool:
    """write new crontab content"""
    try:
        proc = subprocess.run(["crontab", "-"], input=content, capture_output=True, text=True)
        return proc.returncode == 0
    except Exception:
        return False


def _set_cron(name: str, schedule: str, webhook_path: str) -> str:
    """建立或更新一個定時任務"""
    if not name or not schedule or not webhook_path:
        return json.dumps({"success": False, "error": "缺少必要參數"}, ensure_ascii=False)

    # 確保 webhook_path 開頭有 /
    if not webhook_path.startswith("/"):
        webhook_path = "/" + webhook_path

    command = f'curl -s -X POST {WEBHOOK_BASE}{webhook_path}'
    new_line = f'{schedule} {command} {CRON_TAG} {name}'

    current = _get_current_crontab()
    lines = current.strip().split("\n") if current.strip() else []

    # 移除同名的舊任務
    lines = [l for l in lines if f"{CRON_TAG} {name}" not in l]

    # 加入新任務
    lines.append(new_line)

    if _write_crontab("\n".join(lines) + "\n"):
        return json.dumps({
            "success": True,
            "name": name,
            "schedule": schedule,
            "webhook_path": webhook_path,
            "command": command,
            "message": f"定時任務 '{name}' 已設定：{schedule}"
        }, ensure_ascii=False)
    else:
        return json.dumps({"success": False, "error": "寫入 crontab 失敗"}, ensure_ascii=False)


def _list_crons() -> str:
    """列出所有管理的定時任務"""
    current = _get_current_crontab()
    lines = current.strip().split("\n") if current.strip() else []

    managed = []
    for line in lines:
        if CRON_TAG in line:
            # 解析：schedule command # vexa-managed: name
            tag_idx = line.index(CRON_TAG)
            name = line[tag_idx + len(CRON_TAG):].strip()
            cron_part = line[:tag_idx].strip()
            # cron_part = "0 9 * * * curl -s -X POST http://..."
            parts = cron_part.split()
            schedule = " ".join(parts[:5]) if len(parts) >= 5 else cron_part
            command = " ".join(parts[5:]) if len(parts) > 5 else ""
            managed.append({
                "name": name,
                "schedule": schedule,
                "command": command,
            })

    return json.dumps({
        "total": len(managed),
        "jobs": managed
    }, ensure_ascii=False)


def _delete_cron(name: str) -> str:
    """刪除一個定時任務"""
    if not name:
        return json.dumps({"success": False, "error": "缺少任務名稱"}, ensure_ascii=False)

    current = _get_current_crontab()
    lines = current.strip().split("\n") if current.strip() else []

    original_count = len(lines)
    lines = [l for l in lines if f"{CRON_TAG} {name}" not in l]

    if len(lines) == original_count:
        return json.dumps({"success": False, "error": f"找不到任務 '{name}'"}, ensure_ascii=False)

    content = "\n".join(lines) + "\n" if lines else ""
    if _write_crontab(content):
        return json.dumps({
            "success": True,
            "name": name,
            "message": f"定時任務 '{name}' 已刪除"
        }, ensure_ascii=False)
    else:
        return json.dumps({"success": False, "error": "寫入 crontab 失敗"}, ensure_ascii=False)


# ── Telegram 通知工具實作 ─────────────────────────────────

async def _send_processing(chat_id: str, text: str = "⏳ 處理中...") -> str:
    """透過 Telegram Bot API 發送處理中提示，回傳 message_id"""
    if not BOT_TOKEN:
        return json.dumps({"success": False, "error": "BOT_TOKEN 未設定"}, ensure_ascii=False)
    if not chat_id:
        return json.dumps({"success": False, "error": "缺少 chat_id"}, ensure_ascii=False)

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            f"{TG_API_BASE}/sendMessage",
            json={"chat_id": chat_id, "text": text}
        )
        if r.status_code == 200:
            data = r.json()
            if data.get("ok"):
                message_id = data["result"]["message_id"]
                return json.dumps({"success": True, "message_id": message_id}, ensure_ascii=False)
        return json.dumps({"success": False, "error": f"Telegram API 錯誤: {r.status_code} {r.text[:200]}"}, ensure_ascii=False)


# ── 啟動 ──────────────────────────────────────────────────────

async def main():
    async with stdio_server() as (read_stream, write_stream):
        logger.info("Vexa MCP server starting (with Google Sheets)...")
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )


if __name__ == "__main__":
    asyncio.run(main())
