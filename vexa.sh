#!/bin/bash
# NoirsBoxes Vexa 管理腳本（v2 — 對應 Vexa 0.10.6+）
#
# 使用方式：
#   ./vexa.sh up          — 啟動所有服務
#   ./vexa.sh down        — 關閉所有服務
#   ./vexa.sh restart     — 重啟所有服務
#   ./vexa.sh status      — 查看服務狀態
#   ./vexa.sh logs [服務] — 查看 log
#   ./vexa.sh agent       — 啟動 Claude Code Meeting Agent

set -e

# 專案根目錄（用腳本位置推算，避免 hardcoded）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 使用新版官方 compose
COMPOSE="docker compose -f deploy/compose/docker-compose.yml --env-file .env"

# speaches（本地 Whisper 服務）獨立 compose
SPEACHES_COMPOSE="docker compose -f docker-compose.speaches.yml"

# Dashboard (後端 API + 前端 Vite) — 本機程序，用 PID file 管理
DASHBOARD_API_DIR="$SCRIPT_DIR/services/dashboard_api"
DASHBOARD_WEB_DIR="$SCRIPT_DIR/services/dashboard_web"
DASHBOARD_API_PID="/tmp/dashboard_api.pid"
DASHBOARD_WEB_PID="/tmp/dashboard_web.pid"
DASHBOARD_API_LOG="/tmp/dashboard_api.log"
DASHBOARD_WEB_LOG="/tmp/dashboard_web.log"

# Calendar Poller — 獨立背景程序，輪詢 Google Calendar，1 分鐘一次
CALENDAR_POLLER_DIR="$SCRIPT_DIR/services/calendar-poller"
CALENDAR_POLLER_PID="/tmp/calendar_poller.pid"
CALENDAR_POLLER_LOG="/tmp/calendar_poller.log"

# 我們需要的服務
SERVICES=(
  api-gateway
  meeting-api
  runtime-api
  redis
  postgres
  minio
  minio-init
)

# 不需要的服務（已移除）：
#   admin-api    — 只有建 user/token 時才需要，用 ./vexa.sh admin-up 臨時啟動
#   tts-service  — 語音合成，我們不使用
#   mcp          — 官方 MCP，我們有自己的
#   dashboard    — 可選的 Web UI

# 顏色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()    { echo -e "${GREEN}[vexa]${NC} $1"; }
warn()   { echo -e "${YELLOW}[vexa]${NC} $1"; }
error()  { echo -e "${RED}[vexa]${NC} $1"; exit 1; }

# Dashboard 管理函式
dashboard_up() {
  # API
  if [ -f "$DASHBOARD_API_PID" ] && kill -0 "$(cat "$DASHBOARD_API_PID")" 2>/dev/null; then
    warn "dashboard_api 已在運行 (PID $(cat "$DASHBOARD_API_PID"))，跳過"
  else
    log "啟動 dashboard_api（Bun + Hono）..."
    cd "$DASHBOARD_API_DIR"
    nohup bun --env-file=.env src/index.ts > "$DASHBOARD_API_LOG" 2>&1 &
    echo $! > "$DASHBOARD_API_PID"
    cd "$SCRIPT_DIR"
  fi
  # Web
  if [ -f "$DASHBOARD_WEB_PID" ] && kill -0 "$(cat "$DASHBOARD_WEB_PID")" 2>/dev/null; then
    warn "dashboard_web 已在運行 (PID $(cat "$DASHBOARD_WEB_PID"))，跳過"
  else
    log "啟動 dashboard_web（Vite + React）..."
    cd "$DASHBOARD_WEB_DIR"
    nohup npm run dev > "$DASHBOARD_WEB_LOG" 2>&1 &
    echo $! > "$DASHBOARD_WEB_PID"
    cd "$SCRIPT_DIR"
  fi
  sleep 2
  log "dashboard 已啟動 → http://localhost:5173"
}

dashboard_down() {
  for entry in "dashboard_api:$DASHBOARD_API_PID" "dashboard_web:$DASHBOARD_WEB_PID"; do
    name="${entry%%:*}"
    pidfile="${entry##*:}"
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        log "停止 $name (PID $pid)..."
        # kill the process group to catch child processes (Vite spawns subprocess)
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    fi
  done
  # 確保 port 釋放（防 zombie）
  lsof -ti:8765 2>/dev/null | xargs -r kill 2>/dev/null || true
  lsof -ti:5173 2>/dev/null | xargs -r kill 2>/dev/null || true
}

dashboard_status() {
  log "dashboard:"
  for entry in "dashboard_api:8765:$DASHBOARD_API_PID" "dashboard_web:5173:$DASHBOARD_WEB_PID"; do
    name=$(echo "$entry" | cut -d: -f1)
    port=$(echo "$entry" | cut -d: -f2)
    pidfile=$(echo "$entry" | cut -d: -f3)
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      pid=$(cat "$pidfile")
      bound=$(ss -tlnp 2>/dev/null | grep ":$port " | awk '{print $4}' | head -1)
      echo "  ✓ $name (PID $pid) listening on $bound"
    else
      echo "  ✗ $name 未運行"
    fi
  done
}

# Calendar Poller 管理函式
calendar_poller_up() {
  if [ -f "$CALENDAR_POLLER_PID" ] && kill -0 "$(cat "$CALENDAR_POLLER_PID")" 2>/dev/null; then
    warn "calendar-poller 已在運行 (PID $(cat "$CALENDAR_POLLER_PID"))，跳過"
    return
  fi
  log "啟動 calendar-poller（Bun 背景輪詢，1 分鐘一次）..."
  cd "$CALENDAR_POLLER_DIR"
  # 用 dashboard_api 的 .env 共用 DB / OAuth 設定（兩者本來就同一組憑證 + DB）
  if [ -f "$DASHBOARD_API_DIR/.env" ]; then
    nohup bun --env-file="$DASHBOARD_API_DIR/.env" src/index.ts > "$CALENDAR_POLLER_LOG" 2>&1 &
  else
    warn "找不到 $DASHBOARD_API_DIR/.env，calendar-poller 將用 process 環境變數啟動"
    nohup bun src/index.ts > "$CALENDAR_POLLER_LOG" 2>&1 &
  fi
  echo $! > "$CALENDAR_POLLER_PID"
  cd "$SCRIPT_DIR"
  sleep 1
  log "calendar-poller 已啟動 → log: $CALENDAR_POLLER_LOG"
}

calendar_poller_down() {
  if [ -f "$CALENDAR_POLLER_PID" ]; then
    pid=$(cat "$CALENDAR_POLLER_PID")
    if kill -0 "$pid" 2>/dev/null; then
      log "停止 calendar-poller (PID $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$CALENDAR_POLLER_PID"
  fi
  # 防 zombie：把所有跑 calendar-poller/src/index.ts 的 bun process 都清掉
  pkill -f "calendar-poller/src/index.ts" 2>/dev/null || true
}

calendar_poller_status() {
  log "calendar-poller:"
  if [ -f "$CALENDAR_POLLER_PID" ] && kill -0 "$(cat "$CALENDAR_POLLER_PID")" 2>/dev/null; then
    pid=$(cat "$CALENDAR_POLLER_PID")
    echo "  ✓ calendar-poller (PID $pid) — log: $CALENDAR_POLLER_LOG"
  else
    echo "  ✗ calendar-poller 未運行"
  fi
}

case "$1" in

  up)
    log "啟動所有服務..."
    $COMPOSE up -d "${SERVICES[@]}"
    log "啟動 speaches（本地 Whisper）..."
    $SPEACHES_COMPOSE up -d
    dashboard_up
    calendar_poller_up
    log "完成！使用 ./vexa.sh status 確認狀態"
    ;;

  down)
    log "關閉所有服務..."
    $COMPOSE down
    log "關閉 speaches..."
    $SPEACHES_COMPOSE down
    log "關閉 dashboard..."
    dashboard_down
    log "關閉 calendar-poller..."
    calendar_poller_down
    log "完成"
    ;;

  restart)
    log "重啟所有服務..."
    $COMPOSE down
    $SPEACHES_COMPOSE down
    dashboard_down
    calendar_poller_down
    $COMPOSE up -d "${SERVICES[@]}"
    $SPEACHES_COMPOSE up -d
    dashboard_up
    calendar_poller_up
    log "完成"
    ;;

  status)
    $COMPOSE ps
    echo ""
    log "speaches:"
    $SPEACHES_COMPOSE ps
    echo ""
    dashboard_status
    echo ""
    calendar_poller_status
    ;;

  dashboard-up)
    dashboard_up
    ;;

  dashboard-down)
    dashboard_down
    ;;

  calendar-poller-up)
    calendar_poller_up
    ;;

  calendar-poller-down)
    calendar_poller_down
    ;;

  logs)
    if [ -n "$2" ]; then
      log "查看 $2 的 log..."
      $COMPOSE logs -f "$2"
    else
      log "查看所有服務的 log..."
      $COMPOSE logs -f "${SERVICES[@]}"
    fi
    ;;

  rebuild)
    if [ -z "$2" ]; then
      error "請指定服務名稱，例如：./vexa.sh rebuild meeting-api"
    fi
    SERVICE="$2"
    log "重新 build $SERVICE..."
    $COMPOSE build --no-cache "$SERVICE"
    log "重啟 $SERVICE..."
    $COMPOSE up -d --force-recreate "$SERVICE"
    log "完成！查看 log：./vexa.sh logs $SERVICE"
    ;;

  admin-up)
    log "啟動 admin-api..."
    $COMPOSE up -d admin-api
    log "admin-api 已啟動（port 8057），用完後執行: ./vexa.sh admin-down"
    ;;

  admin-down)
    log "關閉 admin-api..."
    $COMPOSE stop admin-api
    log "admin-api 已關閉"
    ;;

  agent)
    log "啟動 Claude Code Meeting Agent..."
    claude --resume noirsboxes-meeting-agent --channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels server:vexa-webhook
    ;;

  *)
    echo ""
    echo "使用方式："
    echo "  ./vexa.sh up                 啟動所有服務"
    echo "  ./vexa.sh down               關閉所有服務"
    echo "  ./vexa.sh restart            重啟所有服務"
    echo "  ./vexa.sh status             查看服務狀態"
    echo "  ./vexa.sh logs               查看所有 log"
    echo "  ./vexa.sh logs <服務>        查看指定服務 log"
    echo "  ./vexa.sh rebuild <服務>     重新 build 並重啟指定服務"
    echo "  ./vexa.sh admin-up           臨時啟動 admin-api（建 user/token）"
    echo "  ./vexa.sh admin-down         關閉 admin-api"
    echo "  ./vexa.sh dashboard-up       單獨啟動 dashboard (api + web)"
    echo "  ./vexa.sh dashboard-down     單獨關閉 dashboard"
    echo "  ./vexa.sh calendar-poller-up   單獨啟動 calendar-poller（背景輪詢）"
    echo "  ./vexa.sh calendar-poller-down 單獨關閉 calendar-poller"
    echo "  ./vexa.sh agent              啟動 Claude Code Meeting Agent"
    echo ""
    echo "可用服務："
    for s in "${SERVICES[@]}"; do
      echo "  - $s"
    done
    echo ""
    ;;

esac
