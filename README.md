# NoirsBoxes AI 會議助理（T3）

AI 參與 Google Meet 會議，自動產出會議記錄與行動清單，追蹤進度與自動跟催。

## 系統架構

```
TG 群組訊息
    ↓ Claude Code Channels（telegram plugin）
Claude Code Session（WSL）
    ↓ 透過 MCP tools
    ├── Vexa MCP → 加入會議 / 查狀態 / 取逐字稿 / summarize
    ├── Google Sheets MCP（gspread + Service Account）→ 讀寫 Action Items
    ├── Google Docs MCP（Service Account）→ 寫入會議記錄
    └── Google Drive MCP（Claude.ai 連接）→ 建立資料夾和空白 Doc

會議結束
    ↓ meeting-api POST http://host.docker.internal:8901/hooks/meeting-completed
    ↓ webhook-channel.ts（Bun，port 8901）接收
    ↓ 推 channel notification 給 Claude Code session
    ↓ Claude 自動：summarize → Google Sheets → Google Doc → 發 TG
```

## 專案結構

```
.
├── README.md                          ← 本文件
├── CLAUDE.md                          ← Claude Code 行為規則
├── vexa.sh                            ← 管理腳本（啟動/關閉/重啟/狀態）
├── .env                               ← 環境變數（不進 git）
├── .env.example                       ← 環境變數範本
├── .mcp.json                          ← webhook channel MCP 設定
├── .gitignore
├── .claude/
│   ├── settings.json                  ← Claude Code permissions + MCP + hooks
│   └── hooks/
│       └── block-google-delete.sh     ← PreToolUse hook 防止誤刪 Google 資料
├── config/
│   ├── departments.json               ← 部門 + 人員對應表（不進 git）
│   └── departments.example.json       ← 對應表範本
├── credentials/
│   └── google-service-account.json    ← Google Service Account 金鑰（不進 git）
├── mcp/
│   ├── server.py                      ← MCP server（所有 17 個 tools）
│   └── webhook-channel.ts             ← 會議結束通知 + 跟催觸發
├── deploy/compose/
│   └── docker-compose.yml             ← Vexa 0.10.6 Docker Compose
└── services/                          ← Vexa 原始碼（官方 + 修正）
    ├── vexa-bot/
    ├── meeting-api/
    ├── runtime-api/
    └── api-gateway/
```

## MCP Tools 清單（17 個）

| 分類 | Tool | 說明 |
|---|---|---|
| Vexa | `join_meeting` | 送 bot 進 Google Meet |
| Vexa | `stop_bot` | 停止 bot（需手動確認） |
| Vexa | `get_status` | 查詢 bot 狀態 |
| Vexa | `get_meetings` | 列出最近會議 |
| Vexa | `get_transcript` | 取得逐字稿 |
| Vexa | `summarize_meeting` | 讀取逐字稿準備摘要 |
| Sheets | `create_sheet` | 建立新 Sheet + 設表頭 + 分享 |
| Sheets | `init_sheet_headers` | 為現有 Sheet 補表頭 |
| Sheets | `append_action_items` | 新增 Action Items |
| Sheets | `update_action_item` | 更新單一 Action Item 欄位 |
| Sheets | `get_action_items` | 讀取 Action Items（可篩選） |
| Docs | `write_doc` | 寫入內容到 Google Doc |
| Cron | `set_cron` | 建立/更新定時任務 |
| Cron | `list_crons` | 列出所有定時任務 |
| Cron | `delete_cron` | 刪除定時任務 |
| Config | `get_config` | 讀取部門 + 人員對應表 |
| Config | `add_department` | 新增部門 |
| Config | `update_member` | 更新人員 TG Username / 逐字稿名字 |

## Docker 服務（Vexa 0.10.6）

| 服務 | Port | 說明 | 必要 |
|---|---|---|---|
| api-gateway | 8056 | API 入口 | ✅ |
| meeting-api | 8080（內部） | Bot 生命週期 + 逐字稿 + webhook | ✅ |
| runtime-api | 8090（內部） | Bot Docker container 管理 | ✅ |
| redis | 6379 | 多服務共用 | ✅ |
| postgres | 5458 | 資料庫 | ✅ |
| minio | 9000 | 錄音檔物件儲存 | ✅ |
| admin-api | 8057 | 建 user/token，按需啟動 | 按需 |

---

# 部署指南

## 環境需求

- **作業系統**：Windows + WSL2（Ubuntu 24）或原生 Linux
- **Docker**：Docker Desktop（Windows）或 Docker Engine（Linux），需支援 compose v2
- **Python**：3.10+
- **Bun**：用於 webhook-channel.ts
- **Claude Code**：需安裝且有 Anthropic 存取權限
- **Cron**：用於每日跟催定時任務（WSL 預設未啟用，需手動開啟）
- **Google 帳號**：用於 Google Drive / Calendar MCP 連接

## 部署步驟

### Step 1：Clone 專案

```bash
git clone <repo-url>
cd vexa
```

### Step 2：建立環境變數

```bash
cp .env.example .env
```

編輯 `.env`，填入以下必要值：

| 變數 | 說明 | 取得方式 |
|---|---|---|
| `TRANSCRIPTION_SERVICE_TOKEN` | Vexa 轉錄服務 token | 向 Vexa 申請 |
| `ADMIN_TOKEN` | Admin API 認證 | 自訂密碼 |
| `VEXA_USER_API_KEY` | MCP 用的 API key（需 bot+tx scope） | Step 6 產生 |
| `BOT_TOKEN` | Telegram Bot token | 透過 @BotFather 建立 |

### Step 3：設定 Google Service Account

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案
2. 啟用 API：Google Sheets API、Google Docs API、Google Drive API
3. 建立 Service Account → 下載 JSON 金鑰
4. 將金鑰放到 `credentials/google-service-account.json`
5. 記下 Service Account email（形如 `xxx@xxx.iam.gserviceaccount.com`）

如需修改分享對象 email：
```bash
# 在 .env 加入
SHARE_WITH_EMAIL=your-email@gmail.com
```

### Step 4：建立部門對應表

```bash
cp config/departments.example.json config/departments.json
```

部門資料會在系統運行時透過 TG 指令自動建立，初始保持空白即可。

### Step 5：安裝依賴

```bash
# Python 依賴
pip install httpx gspread google-api-python-client google-auth mcp

# Bun（如未安裝）
curl -fsSL https://bun.sh/install | bash

# Webhook channel 依賴
cd mcp && bun install && cd ..

# 確認腳本權限
chmod +x vexa.sh
chmod +x .claude/hooks/block-google-delete.sh

# 確認 cron 服務有在跑（WSL 預設未啟動）
sudo service cron start
# 確認 cron 狀態
sudo service cron status
# （選用）設定 WSL 啟動時自動執行 cron：在 /etc/wsl.conf 加入：
# [boot]
# command="service cron start"
```

### Step 6：Build 並啟動 Docker 服務

```bash
# 首次部署：一鍵 build + 啟動 + 初始化 DB + 建 API key
cd deploy/compose
make all-build
cd ../..
```

這會自動：
- Build 所有 Docker image（含 vexa-bot、api-gateway、meeting-api 等）
- 啟動所有服務
- 初始化 PostgreSQL schema
- 建立 dashboard 用的 API key

完成後確認服務狀態：
```bash
./vexa.sh status
```

> ℹ️ 日常重啟用 `./vexa.sh restart`，不需要重新 build。只有更新程式碼後才需要重新 `make build`。

### Step 7：確認 API Token

`make all-build` 已自動建立 API key 並寫入 `.env` 的 `VEXA_API_KEY`。確認它存在：

```bash
grep VEXA_API_KEY .env
```

如果需要手動重建 token：
```bash
./vexa.sh admin-up
curl -X POST "http://localhost:8057/admin/users/1/tokens?scopes=bot,tx" \
  -H "X-Admin-API-Key: <your-admin-token>"
# 把回傳的 token 填入 .env 的 VEXA_USER_API_KEY
./vexa.sh admin-down
```

### Step 8：連接 Google MCP（Claude.ai）

1. 打開 [claude.ai](https://claude.ai)
2. 進入 Settings → Connected Apps
3. 連接 Google Drive、Google Calendar、Google Sheets
4. 使用與 Service Account 同一 Google 帳號登入

### Step 9：啟動 Claude Code Agent

```bash
./vexa.sh agent
```

首次啟動會建立 session `noirsboxes-meeting-agent`，之後會自動 resume。

---

## 驗證部署

啟動後，在 TG 群組中逐步測試（所有訊息都要 **@你的bot名稱** 才會觸發）：

### 測試 1：基本連線
在 TG 群組發送：
```
@NoirsBoxesBot 你好，請確認目前狀態
```
✅ 預期結果：bot 回覆目前服務狀態（執行中的 bot 數量、最近會議等）

### 測試 2：加入會議
開一場測試 Google Meet，然後在 TG 群組發送：
```
@NoirsBoxesBot 請加入這場會議 https://meet.google.com/xxx-xxxx-xxx
```
✅ 預期結果：bot 回覆「已加入會議」，並在 Google Meet 中看到「NoirsBoxes 會議助理」參與者

### 測試 3：會議結束自動處理
在 Google Meet 中說幾句話（測試轉錄），然後結束會議。等待 1-3 分鐘。
✅ 預期結果：bot 自動在 TG 群組發送：
- 會議摘要（8-15 句）
- Action Items 清單
- Google Sheet 連結
- Google Doc 會議記錄連結

### 測試 4：查詢 Action Items
在 TG 群組發送：
```
@NoirsBoxesBot 請查看目前所有未完成的 Action Items
```
✅ 預期結果：bot 回覆剛才會議產生的 Action Items 清單

### 測試 5：跟催功能（選用）
在 TG 群組發送：
```
@NoirsBoxesBot 請設定每天早上 9 點跟催
```
✅ 預期結果：bot 回覆確認已設定定時跟催任務

> ℹ️ `@NoirsBoxesBot` 請替換為你在 @BotFather 建立的實際 bot 名稱。

---

## 常用指令

```bash
# 服務管理
./vexa.sh up                    # 啟動
./vexa.sh down                  # 關閉
./vexa.sh restart               # 重啟
./vexa.sh status                # 狀態
./vexa.sh logs                  # 所有 log
./vexa.sh logs meeting-api      # 指定服務 log

# Agent
./vexa.sh agent                 # 啟動 Claude Code Agent

# Admin（按需）
./vexa.sh admin-up              # 啟動 admin-api
./vexa.sh admin-down            # 關閉 admin-api

# 偵錯
docker ps --format "{{.Names}} {{.Status}}" | grep meeting-
cat mcp/webhook-channel.log
docker exec vexa-postgres-1 psql -U postgres -d vexa -c \
  "SELECT id, status, start_time FROM meetings ORDER BY created_at DESC LIMIT 5;"
```

---

## 認證方式一覽

| 用途 | 方式 | 位置 |
|---|---|---|
| Vexa API | API Token（bot+tx scope） | `.env` → `VEXA_USER_API_KEY` |
| Google Sheets/Docs | Service Account JSON | `credentials/google-service-account.json` |
| Google Drive/Calendar | Claude.ai Google MCP 連接 | Claude.ai Settings |
| Admin API | Admin Token | `.env` → `ADMIN_TOKEN` |
| Telegram | Bot Token | `.env` → `BOT_TOKEN` |

---

## 安全規則

- ❌ 不可刪除 Google Drive / Sheets / Calendar 上的任何資料
- ❌ `stop_bot` 需使用者明確要求才能執行
- ❌ 不在 TG 回覆中暴露內部資訊（chat_id、sheet_id、webhook URL 等）
- ✅ 可以新增檔案和資料夾
- ✅ 可以更新 Action Item 欄位內容
- ✅ 部門隔離：每個群組只能看到自己的資料

---

## 疑難排解

**Bot 加不進會議**
- 確認 `./vexa.sh status` 所有服務正常
- 確認 API token 有 `bot` scope
- 查看 log：`./vexa.sh logs meeting-api`

**會議結束但沒有自動產出記錄**
- 確認 webhook channel 在跑：`cat mcp/webhook-channel.log`
- 確認 `POST_MEETING_HOOKS` 設定正確
- 手動測試：`curl -s -X POST http://localhost:8901/health`

**Google Sheets/Docs 寫入失敗**
- 確認 `credentials/google-service-account.json` 存在且有效
- 確認 Service Account 有被分享到目標 Sheet/Doc
- 確認 Google Sheets API、Docs API、Drive API 都已啟用

**逐字稿出現整句英文**
- 這是 Whisper 對中英混雜的已知行為
- 系統會在寫入 Google Doc 時自動翻譯為中文
- 如問題嚴重，可考慮在 Vexa 轉錄設定中指定 language=zh

**Claude Code session compaction 後遺失上下文**
- 設計上已緩解：所有動態資料在 `config/departments.json`
- 每次操作前 Claude 會自動用 `get_config` 查詢
- 不需要手動介入
