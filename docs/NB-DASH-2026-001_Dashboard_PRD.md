# NoirsBoxes Meeting Dashboard — 需求規格文件

**文件編號：** NB-DASH-2026-001
**版本：** v1.0
**日期：** 2026-05-17
**狀態：** 確認

---

## 1. 專案概述

### 1.1 背景

NoirsBoxes T3 會議助理系統目前透過 Telegram 提供所有互動功能。客戶希望有一個網頁介面，能更直覺地追蹤 Action Items 進度、瀏覽會議記錄、即時監控 Bot 狀態，以及直接派發 Bot 加入會議。

### 1.2 目標

在客戶機器上架設一個簡易網站（localhost），提供：

- Action Items 即時追蹤與編輯（Notion 風格）
- 會議記錄瀏覽與搜尋（Vexa Dashboard 風格）
- Bot 狀態監控與派發
- 部門權限隔離
- 管理員設定介面

### 1.3 與現有系統的關係

Dashboard 是額外的管理介面，Telegram 功能全部保留。兩者共用同一套後端資料，不互相衝突。

---

## 2. 系統架構

### 2.1 技術方案

| 項目 | 技術選型 |
|---|---|
| 前端 | React + Tailwind CSS |
| 後端 API | Bun + Hono（輕量 HTTP server） |
| 資料庫 | PostgreSQL（Vexa 已有實例，新增自訂 table） |
| 會議記錄儲存 | 本地 Markdown 檔案（`/records/{部門}/`） |
| Bot 狀態 | Polling Vexa API（每 10 秒） |
| 部署 | Docker container 或直接跑在 Bun 上 |
| Port | 3000（可設定） |

### 2.2 資料流

```
會議結束 → Agent 寫入：
    ├── PostgreSQL（meetings 表 + action_items 表）
    ├── /records/{部門}/MMDD_{標題}_{meet-id}.md（會議記錄全文）
    ├── Google Sheets（Action Items 備份）
    └── TG 通知（摘要 + 連結）

Dashboard：
    ├── 讀取 PostgreSQL（Action Items、會議列表）
    ├── 讀取 /records/*.md（會議記錄詳情）
    ├── Polling Vexa API（Bot 狀態）
    └── 呼叫 Vexa API（派發 Bot）

用戶在 Dashboard 編輯：
    ├── 寫入 PostgreSQL
    └── Agent 下次讀 DB 時同步到 Google Sheets
```

### 2.3 資料庫 Schema（新增到 Vexa PostgreSQL）

```sql
CREATE TABLE nb_departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    chat_id VARCHAR(50),
    sheet_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE nb_meetings (
    id SERIAL PRIMARY KEY,
    department_id INTEGER REFERENCES nb_departments(id),
    vexa_meeting_id INTEGER,
    title VARCHAR(500) NOT NULL,
    meet_id VARCHAR(100),
    platform VARCHAR(50) DEFAULT 'Google Meet',
    status VARCHAR(20) DEFAULT 'completed',
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    duration_minutes INTEGER,
    participants TEXT[],
    summary TEXT,
    record_path VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE nb_action_items (
    id SERIAL PRIMARY KEY,
    meeting_id INTEGER REFERENCES nb_meetings(id),
    department_id INTEGER REFERENCES nb_departments(id),
    code VARCHAR(20) NOT NULL,
    description TEXT NOT NULL,
    assignee VARCHAR(100),
    priority VARCHAR(10) DEFAULT '中',
    done BOOLEAN DEFAULT FALSE,
    due_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE nb_admin (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT
);
```

### 2.4 Markdown 檔案結構

```
/records/
    ├── 業務部/
    │   ├── 0512_工作時程確認_oah-pjja-hdg.md
    │   └── 0506_創業方向討論_abc-defg-hij.md
    └── 研發部/
        └── 0510_韌體技術評審_xyz-uvwx-rst.md
```

---

## 3. 頁面規格

### 3.1 登入頁

- 選擇部門（按鈕式選擇器）
- 輸入部門密碼
- 密碼驗證後存入 cookie（7 天有效）

### 3.2 Action Items 頁（Notion 風格）

- 兩個分區：「進行中（To-do）」和「已完成（Done）」
- 每個分區內按負責人分組
- Checkbox 打勾直接切換狀態
- 點擊文字原地編輯（描述、截止日、負責人）
- 進行中：白底卡片，黃色標題
- 已完成：淺綠底卡片，刪除線

### 3.3 會議記錄頁（Vexa Dashboard 風格）

- 表格式列表：平台 / 會議名稱 / 狀態 / 時長 / 參與者 / 時間
- 搜尋框 + 狀態篩選
- 點擊列進入會議詳情

### 3.4 會議詳情頁

- 返回按鈕 + 會議 metadata
- 三個 Tab：摘要 / Action Items / 逐字稿
- 逐字稿渲染完整 Markdown

### 3.5 左側導航欄

- Logo + 版本號
- Action Items / 會議記錄
- Bot 狀態（在線/離線）+ 進行中會議
- Meet 連結輸入 + 加入會議按鈕
- 管理設定（需 admin 密碼）
- 當前部門 + 切換按鈕

### 3.6 管理設定頁（需 Admin 密碼）

- Admin 密碼獨立於部門密碼
- 部門管理：列表 / 新增 / 編輯
- 系統資訊顯示

---

## 4. 權限控制

| 角色 | 可見範圍 | 可操作 |
|---|---|---|
| 部門成員 | 該部門的 Action Items + 會議記錄 | 編輯 AI 狀態和內容、派發 Bot |
| 管理員 | 所有部門 | 部門 CRUD、系統設定 |

---

## 5. API 端點

```
POST /api/auth/login              # 部門登入
POST /api/auth/admin              # 管理員驗證
GET  /api/action-items?dept=      # 列出 Action Items
PATCH /api/action-items/:id       # 更新 Action Item
GET  /api/meetings?dept=          # 列出會議
GET  /api/meetings/:id            # 會議詳情
GET  /api/meetings/:id/transcript # 讀取逐字稿 Markdown
GET  /api/bot/status              # Bot 狀態
POST /api/bot/join                # 派發 Bot
POST /api/bot/stop                # 停止 Bot
GET  /api/admin/departments       # 列出部門
POST /api/admin/departments       # 新增部門
PATCH /api/admin/departments/:id  # 編輯部門
```

---

## 6. 與現有系統整合

### Agent 寫入流程（需修改 MCP）

新增 tool：
- `save_meeting_record` — 寫入 DB + Markdown 檔
- `save_action_items_db` — 寫入 DB

### 衝突處理

| 情境 | 處理 |
|---|---|
| Dashboard 改 AI + Agent 同時寫 | DB transaction，last write wins |
| Dashboard 派發 Bot + TG 同時派發 | Vexa API 409 Conflict |
| Agent 寫 Markdown + Dashboard 讀 | 一寫一讀，無衝突 |

---

## 7. 部署

Docker 或直接 Bun 執行，Port 3000。

---

## 8. 開發順序

| 階段 | 內容 |
|---|---|
| Phase 1 | 前端 UI（已完成 mockup） |
| Phase 2 | 後端 API server + DB schema |
| Phase 3 | 前後端串接 |
| Phase 4 | Agent 整合（MCP 新增 DB 寫入 tool） |
| Phase 5 | 部署 + 測試 |

---

## 9. 設計參考

- Action Items：Notion 待辦清單（按負責人分組 + checkbox）
- 會議列表：Vexa Dashboard 表格風格
- 整體風格：白底乾淨介面，左側導航欄
- 會議詳情：Tab 切換，Markdown 渲染
