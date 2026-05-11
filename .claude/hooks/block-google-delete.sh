#!/bin/bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

if echo "$TOOL_NAME" | grep -qi "google" && echo "$INPUT" | jq -r '.tool_input | tostring' | grep -qiE "delete|remove|clear|trash|empty"; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"🚫 Google 資料刪除操作已被攔截。"}}'
  exit 2
fi

exit 0
