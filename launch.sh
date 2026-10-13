#!/bin/bash
# QQ 音乐解锁器入口脚本。
#   双击应用包 / 无参数        -> 启动界面（已有会话就直接打开界面）
#   把文件拖到应用图标上       -> 追加进当前队列并打开界面
#   带目录或转换参数           -> 命令行批量模式
#       ./launch.sh ~/Music/下载目录 -o ~/Desktop -b 320k
#       ./launch.sh a.mgg b.mflac
#   其他：--new-session 强制开新会话；--stop 关掉正在运行的服务
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 应用包内：代码在 ../Resources/app；仓库里直接跑：代码在 ./app
if [ -d "$HERE/../Resources/app" ]; then
  APP_DIR="$(cd "$HERE/../Resources/app" && pwd)"
else
  APP_DIR="$HERE/app"
fi

LOG_DIR="$HOME/Library/Logs/QQMusicUnlocker"
RT="$LOG_DIR/runtime.json"
LOG="$LOG_DIR/launcher.log"
mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

# ---------- 参数解析 ----------
FORCE_NEW=0
STOP=0
CLI_MODE=0          # 是否以命令行模式运行
INPUTS=()           # 位置参数（文件 / 目录）
CLI_ARGS=()         # 透传给引擎的选项与值
while [ "$#" -gt 0 ]; do
  case "$1" in
    --new-session) FORCE_NEW=1 ;;
    --stop) STOP=1 ;;
    -o|--outdir|-b|--bitrate)
      CLI_ARGS+=("$1"); CLI_MODE=1
      [ "$#" -ge 2 ] && { CLI_ARGS+=("$2"); shift; } ;;
    --keep-ogg) CLI_ARGS+=("$1"); CLI_MODE=1 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) INPUTS+=("$1") ;;
  esac
  shift
done

SUPPORTED_RE='\.(mgg|mgg1|mggl|mflac|mflac0|mflac1|qmcogg|qmcflac|qmc0|qmc2|qmc3)$'
if [ "${#INPUTS[@]}" -gt 0 ]; then
  for f in "${INPUTS[@]}"; do
    if [ ! -f "$f" ] || [[ ! "$f" =~ $SUPPORTED_RE ]]; then
      case "$f" in
        *" -o "*|*" -b "*|*--keep-ogg*) ;;   # 用户把选项写在了路径后面，交给引擎处理
      esac
      CLI_MODE=1
    fi
  done
fi

# ---------- python / ffmpeg ----------
PY=""
for cand in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$cand" ] && "$cand" -c 'import plistlib, sqlite3' 2>/dev/null; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  /usr/bin/osascript -e 'display alert "缺少 Python 3" message "请先安装命令行工具：xcode-select --install"' >/dev/null 2>&1 || true
  echo "未找到可用的 python3" >&2
  exit 1
fi

for d in /opt/homebrew/bin /usr/local/bin /usr/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH
if ! command -v ffmpeg >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display alert "缺少 ffmpeg" message "请先在终端执行：brew install ffmpeg"' >/dev/null 2>&1 || true
  echo "缺少 ffmpeg，请先 brew install ffmpeg" >&2
  exit 1
fi

# ---------- 会话状态 ----------
session_alive() {
  [ -s "$RT" ] || return 1
  local pid
  pid="$("$PY" - "$RT" <<'PYEOF' 2>/dev/null || true
import json, sys
print(json.load(open(sys.argv[1])).get("pid", ""))
PYEOF
)"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null
}

read_rt() {  # read_rt <字段>
  "$PY" - "$RT" "$1" <<'PYEOF'
import json, sys
print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))
PYEOF
}

open_ui() {  # open_ui <路径>
  local base
  base="$(read_rt port)"
  local tok
  tok="$(read_rt token)"
  local url="http://127.0.0.1:${base}/"
  [ -n "$tok" ] && url="${url}?t=${tok}"
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "$url"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -a "Microsoft Edge" "$url"
  elif [ -d "/Applications/Brave Browser.app" ]; then
    open -a "Brave Browser" "$url"
  else
    open "$url"
  fi
}

push_files() {  # push_files <绝对路径...> 把文件塞进运行中的队列
  local paths_json
  paths_json="$("$PY" - "$@" <<'PYEOF'
import json, sys
print(json.dumps({"paths": [p for p in sys.argv[1:]]}))
PYEOF
)"
  local port tok code
  port="$(read_rt port)"
  tok="$(read_rt token)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -H "Content-Type: application/json" -H "X-Token: ${tok}" \
    -d "$paths_json" "http://127.0.0.1:${port}/api/open" || echo 000)"
  [ "$code" = "200" ]
}

stop_session() {
  if session_alive; then
    local port tok
    port="$(read_rt port)"
    tok="$(read_rt token)"
    curl -s -m 5 -H "Content-Type: application/json" -H "X-Token: ${tok}" \
      -d '{}' "http://127.0.0.1:${port}/api/quit" >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -f "$RT"
  log "会话已结束"
}

if [ "$STOP" = "1" ]; then
  stop_session
  exit 0
fi

# ---------- 命令行模式 ----------
if [ "$CLI_MODE" = "1" ]; then
  exec "$PY" "$APP_DIR/qmengine.py" "${INPUTS[@]+"${INPUTS[@]}"}" "${CLI_ARGS[@]+"${CLI_ARGS[@]}"}"
fi

# ---------- 界面模式 ----------
if [ "$FORCE_NEW" = "1" ] && session_alive; then
  log "强制开新会话，先结束旧会话"
  stop_session
fi

if session_alive; then
  log "复用已有会话 $(read_rt port)"
  if [ "${#INPUTS[@]}" -gt 0 ]; then
    if push_files "${INPUTS[@]}"; then
      log "已追加 ${#INPUTS[@]} 个文件"
    else
      log "追加文件失败（会话可能刚退出），转开新会话"
      INPUTS=()
    fi
  fi
  if [ -s "$RT" ]; then
    open_ui
    exit 0
  fi
fi

TOKEN="$("$PY" -c 'import secrets;print(secrets.token_hex(16))')"
rm -f "$RT"
"$PY" "$APP_DIR/server.py" --token "$TOKEN" --runtime-file "$RT" --no-browser >>"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  [ -s "$RT" ] && break
  sleep 0.25
done
if [ ! -s "$RT" ]; then
  /usr/bin/osascript -e 'display alert "启动失败" message "服务没有起来，详见 ~/Library/Logs/QQMusicUnlocker/launcher.log"' >/dev/null 2>&1 || true
  exit 1
fi
log "新会话启动 pid=$SERVER_PID port=$(read_rt port)"

if [ "${#INPUTS[@]}" -gt 0 ]; then
  push_files "${INPUTS[@]}" && log "已追加 ${#INPUTS[@]} 个文件" || true
  INPUTS=()
fi

open_ui

trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
wait "$SERVER_PID"
