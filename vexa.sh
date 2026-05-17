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

case "$1" in

  up)
    log "啟動所有服務..."
    $COMPOSE up -d "${SERVICES[@]}"
    log "啟動 speaches（本地 Whisper）..."
    $SPEACHES_COMPOSE up -d
    log "完成！使用 ./vexa.sh status 確認狀態"
    ;;

  down)
    log "關閉所有服務..."
    $COMPOSE down
    log "關閉 speaches..."
    $SPEACHES_COMPOSE down
    log "完成"
    ;;

  restart)
    log "重啟所有服務..."
    $COMPOSE down
    $SPEACHES_COMPOSE down
    $COMPOSE up -d "${SERVICES[@]}"
    $SPEACHES_COMPOSE up -d
    log "完成"
    ;;

  status)
    $COMPOSE ps
    echo ""
    log "speaches:"
    $SPEACHES_COMPOSE ps
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
    echo "  ./vexa.sh agent              啟動 Claude Code Meeting Agent"
    echo ""
    echo "可用服務："
    for s in "${SERVICES[@]}"; do
      echo "  - $s"
    done
    echo ""
    ;;

esac
