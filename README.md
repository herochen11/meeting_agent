# Vexa Meeting Transcription Platform

基於 [Vexa-ai/vexa](https://github.com/Vexa-ai/vexa) 的自部署版本，部署於 deFintek 基礎設施。

## 🏗️ 架構

- **前端 Dashboard**: Next.js ([Vexa-Dashboard](https://github.com/reyerchu/Vexa-Dashboard)) — `vexa.defintek.io`
- **後端 API Gateway**: FastAPI — port 8056
- **轉錄引擎**: WhisperLive + Groq Whisper API (whisper-large-v3, 免費)
- **AI 會議摘要**: Meeting Summarizer + Groq LLama 3.3 70B (免費)
- **資料庫**: PostgreSQL 15 + Redis
- **物件儲存**: MinIO (錄音檔)

## 🚀 服務列表

| 服務 | Port | 說明 |
|------|------|------|
| API Gateway | 8056 | 主要 API 入口 |
| Admin API | 8057 | 管理 API |
| Bot Manager | - | Google Meet Bot 管理 |
| WhisperLive | 9090 | 即時語音轉文字 (WebSocket) |
| Transcription Collector | 8123 | 轉錄結果收集 |
| Meeting Summarizer | 8900 | AI 會議摘要自動生成 |
| MCP | 18888 | Model Context Protocol 服務 |
| TTS Service | - | 文字轉語音 |
| Dashboard | 3000 | Web 前端 |
| PostgreSQL | 5438 | 資料庫 |
| Redis | 6381 | 快取 |
| MinIO | 9000/9001 | 物件儲存 |

## 🎯 主要功能

### 即時會議轉錄
- Google Meet Bot 自動加入會議
- Groq Whisper API 即時語音轉文字
- WebSocket 即時推送轉錄結果到 Dashboard

### AI 會議摘要（自動）
會議結束後自動生成：
- 📋 **Summary** — 會議摘要
- 📝 **Meeting Minutes** — 會議記錄
- ✅ **Action Items** — 執行項目
- 💡 **Key Decisions** — 重要決策

使用 Groq LLama 3.3 70B（免費 API）

### 認證
- Google OAuth 登入
- Email Magic Link 登入

## 🔧 自訂修改（相對於上游）

### docker-compose.yml
- 新增 `meeting-summarizer` 服務
- 設定 `POST_MEETING_HOOKS` webhook
- 配置 Groq API 環境變數

### WhisperLive (`services/WhisperLive/whisper_live/remote_transcriber.py`)
- 移除 Groq 不支援的 `transcription_tier` 和 `timestamp_granularities` 參數
- 新增 Whisper 幻覺過濾器（過濾靜音時的垃圾文字）
- 新增 debug logging（API 錯誤時顯示回應內容）

### Meeting Summarizer (`services/meeting-summarizer/`)
- 全新服務：會議結束時自動呼叫 Groq LLM 生成摘要
- Webhook endpoint: `POST /hooks/meeting-completed`
- 結果存入 PostgreSQL `meetings.data.ai_summary`

## 📦 部署

```bash
# 複製環境設定
cp env-example.cpu .env

# 編輯 .env 設定以下關鍵項目：
# - REMOTE_TRANSCRIBER_API_KEY=<your-groq-api-key>
# - REMOTE_TRANSCRIBER_MODEL=whisper-large-v3
# - POST_MEETING_HOOKS=http://meeting-summarizer:8900/hooks/meeting-completed

# 啟動所有服務
docker compose up -d

# Dashboard 另外部署（見 Vexa-Dashboard repo）
```

## 🌐 網域

- Dashboard: `https://vexa.defintek.io`
- API: `https://vexa.defintek.io/api/...`（透過 Dashboard proxy）
- WebSocket: `wss://vexa.defintek.io/ws`

## 📝 License

基於上游 Vexa 專案授權。
