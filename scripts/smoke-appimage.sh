#!/usr/bin/env bash
# 在无显示器的 Linux 上冒烟 AppImage：Xvfb 里启动 → 等窗口出现 → 找到本地服务端口 → 带 token 调 /api/health → 截窗口图。
# 用法：scripts/smoke-appimage.sh <LULUX-ETA-*.AppImage> [截图输出.png]
# 依赖：xvfb、xauth、x11-utils（xwininfo）、imagemagick（import）、curl、ss（iproute2）
set -euo pipefail

APPIMAGE="$(readlink -f "${1:?用法：$0 <AppImage> [screenshot.png]}")"
SHOT="${2:-$(dirname "$APPIMAGE")/smoke-window.png}"
DISPLAY_NUM="${SMOKE_DISPLAY:-:99}"
TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
WORK="$(mktemp -d /tmp/lulux-smoke.XXXXXX)"
LOG="$WORK/app.log"
export LULUX_ETA_HOME="$WORK/data"

# 从 /api/kernels 的 JSON 里取出某个内核（不依赖 jq / node）
node_json_pick() {
  python3 -c 'import json,sys; ks=json.load(sys.stdin); print(json.dumps([k for k in ks if k["id"]==sys.argv[1]][0], ensure_ascii=False, separators=(",",":")))' "$1"
}

cleanup() {
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true
  sleep 1
  [[ -n "${APP_PID:-}" ]] && pkill -9 -P "$APP_PID" 2>/dev/null || true
  [[ -n "${XVFB_PID:-}" ]] && kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

Xvfb "$DISPLAY_NUM" -screen 0 1440x900x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1
export DISPLAY="$DISPLAY_NUM"

# --appimage-extract-and-run：容器里通常没有 FUSE；--no-sandbox：容器里没有 user namespace（真实桌面不需要）
chmod +x "$APPIMAGE"
LULUX_API_TOKEN="$TOKEN" APPIMAGE_EXTRACT_AND_RUN=1 \
  "$APPIMAGE" --no-sandbox --disable-gpu >"$LOG" 2>&1 &
APP_PID=$!
echo "[smoke] pid=$APP_PID data=$LULUX_ETA_HOME"

# 1. 窗口出现（标题 LULUX ETA）
WINDOW=""
for _ in $(seq 1 90); do
  WINDOW="$(xwininfo -root -tree 2>/dev/null | grep -E '"LULUX ETA"' | head -1 | awk '{print $1}')" || true
  [[ -n "$WINDOW" ]] && break
  if ! kill -0 "$APP_PID" 2>/dev/null; then echo "[smoke] 应用已退出"; cat "$LOG"; exit 1; fi
  sleep 1
done
[[ -n "$WINDOW" ]] || { echo "[smoke] 90 秒内没有窗口"; tail -50 "$LOG"; exit 1; }
echo "[smoke] window=$WINDOW"

# 2. 服务端口：本进程树里监听 127.0.0.1 的端口，带 token 的 /api/health 返回 {ok:true}
PORT=""
for _ in $(seq 1 60); do
  for p in $(ss -ltnH 2>/dev/null | awk '{print $4}' | grep '^127.0.0.1:' | cut -d: -f2); do
    body="$(curl -fsS -m 2 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$p/api/health" 2>/dev/null || true)"
    [[ "$body" == *'"ok":true'* ]] || continue
    # 同机可能有别的服务也回 ok：本应用的 /api/health 无 token 必须 401
    [[ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/api/health")" == "401" ]] && { PORT="$p"; break; }
  done
  [[ -n "$PORT" ]] && break
  sleep 1
done
[[ -n "$PORT" ]] || { echo "[smoke] 找不到就绪的服务端口"; tail -50 "$LOG"; exit 1; }
NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")"
MODE="$(curl -fsS "http://127.0.0.1:$PORT/api/auth/mode")"
KERNELS="$(curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/kernels" | head -c 300)"
echo "[smoke] port=$PORT health(with token)=ok health(no token)=$NOAUTH mode=$MODE"
echo "[smoke] kernels=${KERNELS}…"
[[ "$NOAUTH" == "401" ]] || { echo "[smoke] 无 token 应为 401"; exit 1; }

# 2b. 可选：用随包 npm 实际安装一个第三方内核（SMOKE_KERNEL=qwen-code 等），验证用户机器无需 Node/npm
if [[ -n "${SMOKE_KERNEL:-}" ]]; then
  auth=(-H "Authorization: Bearer $TOKEN")
  curl -fsS "${auth[@]}" -X POST "http://127.0.0.1:$PORT/api/kernels/$SMOKE_KERNEL/install" >/dev/null
  deadline=$(( $(date +%s) + ${SMOKE_KERNEL_TIMEOUT:-300} ))
  while :; do
    k="$(curl -fsS "${auth[@]}" "http://127.0.0.1:$PORT/api/kernels" | node_json_pick "$SMOKE_KERNEL")"
    [[ "$k" != *'"status":"installing"'* ]] && break
    (( $(date +%s) > deadline )) && { echo "[smoke] 内核安装超时"; break; }
    sleep 3
  done
  echo "[smoke] kernel=$k"
  curl -fsS "${auth[@]}" "http://127.0.0.1:$PORT/api/kernels/$SMOKE_KERNEL/log" | head -c 4000 | tr ',' '\n' | grep -E 'lulux|npm (warn|error)|added' | sed 's/^/[smoke]   /' || true
  [[ "$k" == *'"installed":true'* ]] || { echo "[smoke] 内核安装失败"; exit 1; }
fi

# 3. 等界面渲染后截图（整个虚拟屏幕；无边框窗口即应用画面）
sleep "${SMOKE_RENDER_WAIT:-8}"
import -display "$DISPLAY_NUM" -window root "$SHOT"
echo "[smoke] screenshot=$SHOT"
ls "$LULUX_ETA_HOME" | sed 's/^/[smoke] data: /'
echo "[smoke] OK"
