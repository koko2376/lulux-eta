#!/usr/bin/env bash
# 自动更新冒烟（Linux AppImage，Xvfb）：本地 HTTP 模拟发布源 → 旧版本检测到新版本 → 下载（差分/全量）→ sha512 校验 →
# 经 window.lulux.updater.install() 重启并安装 → 旧文件被替换为新版本 AppImage → 新版本启动。
#
#   scripts/update-smoke/smoke-update-appimage.sh <旧版本.AppImage> <新版本发布目录>
#
# <新版本发布目录> 里要有 latest-linux.yml（x64）或 latest-linux-arm64.yml（arm64）与它引用的 AppImage，
# 即 scripts/build-release.sh --out 的输出目录。旧版本必须是带自动更新代码的构建。
#
# SMOKE_EXPECT=reject：发布源被篡改（例如 yml 里的 sha512 不对）时应拒绝安装——等待后台下载失败，
# 断言状态不是 downloaded、lastError 为后台错误（interactive=false，不打扰用户）、旧文件未被替换。
# 依赖：xvfb、x11-utils（xwininfo）、node、curl。结果写到 $WORK/result.txt，并打印 WORK 目录（日志都在里面）。
set -euo pipefail

OLD="$(readlink -f "${1:?用法：$0 <旧版本.AppImage> <新版本发布目录>}")"
FEED="$(readlink -f "${2:?缺少新版本发布目录}")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPLAY_NUM="${SMOKE_DISPLAY:-:98}"
CDP_PORT="${SMOKE_CDP_PORT:-9333}"
WORK="$(mktemp -d /tmp/lulux-update-smoke.XXXXXX)"
APPS="$WORK/apps"
mkdir -p "$APPS" "$WORK/config"
cp "$OLD" "$APPS/"
TARGET="$APPS/$(basename "$OLD")"
chmod +x "$TARGET"
LOG_DIR="$WORK/config/LULUX ETA/logs"
UPDATER_LOG="$LOG_DIR/updater.log"
cdp() { node "$HERE/cdp-eval.mjs" "$CDP_PORT" "$1"; }
step() { printf '\n\033[1;34m[update-smoke]\033[0m %s\n' "$*"; }

cleanup() {
  pkill -f "$APPS/" 2>/dev/null || true
  pkill -f "appimage_extracted" 2>/dev/null || true
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${XVFB_PID:-}" ]] && kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

step "WORK=$WORK"
step "发布源：$FEED"
ls -la "$FEED"
node "$HERE/serve-updates.mjs" "$FEED" 0 --port-file "$WORK/port" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; sleep 0.1; done
FEED_URL="http://127.0.0.1:$(cat "$WORK/port")/"

Xvfb "$DISPLAY_NUM" -screen 0 1440x900x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1
export DISPLAY="$DISPLAY_NUM"

step "启动旧版本 $(basename "$TARGET")，更新源 $FEED_URL"
XDG_CONFIG_HOME="$WORK/config" LULUX_ETA_HOME="$WORK/data" \
  LULUX_UPDATE_URL="$FEED_URL" LULUX_UPDATE_INITIAL_DELAY_MS=3000 \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  "$TARGET" --no-sandbox --disable-gpu --remote-debugging-port="$CDP_PORT" >"$WORK/app-old.log" 2>&1 &
OLD_PID=$!

for _ in $(seq 1 90); do
  cdp 'typeof window.lulux?.updater?.getState' >/dev/null 2>&1 && break
  kill -0 "$OLD_PID" 2>/dev/null || { echo "旧版本已退出"; cat "$WORK/app-old.log"; exit 1; }
  sleep 1
done
step "preload 接口：$(cdp 'Object.keys(window.lulux).join(",") + " | updater: " + Object.keys(window.lulux.updater).join(",") + " | win: " + Object.keys(window.lulux.win).join(",")')"
step "初始设置：$(cdp 'window.lulux.updater.getSettings()')"
step "非法设置被拒绝：$(cdp 'window.lulux.updater.setSettings({channel:"nightly"}).then(()=>"accepted (BUG)",e=>"rejected: "+e.message)')"
# 订阅状态：界面接管提示后主进程不弹原生对话框（也验证 onState 推送）
cdp 'window.__states=[]; window.__off=window.lulux.updater.onState(s=>window.__states.push(s.status+(s.progress?":"+s.progress.percent:""))); "subscribed"' >/dev/null

EXPECT="${SMOKE_EXPECT:-update}"
STATUS=""
last=""
for _ in $(seq 1 300); do
  state="$(cdp 'window.lulux.updater.getState()' 2>/dev/null || true)"
  STATUS="$(node -e 'try{const s=JSON.parse(process.argv[1]);console.log(s.status)}catch{console.log("")}' "$state")"
  line="$(node -e 'try{const s=JSON.parse(process.argv[1]);console.log(s.status+(s.available?" → "+s.available.version:"")+(s.progress?" "+s.progress.percent+"% "+s.progress.transferred+"/"+s.progress.total:"")+(s.lastError?" err="+s.lastError.message:""))}catch{}' "$state")"
  [[ "$line" != "$last" ]] && { echo "  state: $line"; last="$line"; }
  [[ "$STATUS" == "downloaded" || "$STATUS" == "error" ]] && break
  if [[ "$EXPECT" == "reject" ]] && node -e 'process.exit(JSON.parse(process.argv[1]).lastError?0:1)' "$state" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$EXPECT" == "reject" ]]; then
  echo "$state" >"$WORK/state-reject.json"
  node -e '
    const s = JSON.parse(process.argv[1])
    const ok = s.status !== "downloaded" && s.lastError && s.lastError.interactive === false
    console.log(ok ? "拒绝成功：status=" + s.status + " lastError=" + s.lastError.message : "未按预期拒绝：" + JSON.stringify(s))
    process.exit(ok ? 0 : 1)' "$state"
  sleep 2
  [[ -f "$TARGET" ]] && ! ls "$APPS" | grep -qv "$(basename "$TARGET")" || { echo "旧文件被改动"; ls -la "$APPS"; exit 1; }
  step "旧文件保持不变：$(ls "$APPS")"
  step "updater.log（错误部分）"; grep -E "error|sha512" "$UPDATER_LOG" | cut -c1-300 | head -10
  echo "reject=yes" >"$WORK/result.txt"
  exit 0
fi
echo "$state" >"$WORK/state-before-install.json"
step "onState 推送序列：$(cdp 'Array.from(new Set(window.__states)).slice(0,40).join(" ")')"
[[ "$STATUS" == "downloaded" ]] || { echo "没有下载完成（status=$STATUS）"; cat "$UPDATER_LOG" || true; exit 1; }

step "调用 window.lulux.updater.install()"
cdp 'window.lulux.updater.install()' || true

for _ in $(seq 1 60); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
kill -0 "$OLD_PID" 2>/dev/null && { echo "旧版本 60 秒内没有退出"; exit 1; }
step "旧版本已退出；应用目录："
ls -la "$APPS"

NEW_NAME="$(sed -n 's/^path: *//p' "$FEED"/latest-linux*.yml | head -1)"
NEW_VERSION="$(sed -n 's/^version: *//p' "$FEED"/latest-linux*.yml | head -1)"
[[ -f "$APPS/$NEW_NAME" ]] || { echo "没有找到新版本文件 $NEW_NAME"; exit 1; }
[[ "$APPS/$NEW_NAME" == "$TARGET" || ! -e "$TARGET" ]] || { echo "旧文件仍在：$TARGET"; exit 1; }
NEW_SHA="$(sha256sum "$APPS/$NEW_NAME" | cut -d' ' -f1)"
FEED_SHA="$(sha256sum "$FEED/$NEW_NAME" | cut -d' ' -f1)"
[[ "$NEW_SHA" == "$FEED_SHA" ]] || { echo "替换后的文件与发布源不一致"; exit 1; }
step "替换成功：$NEW_NAME（sha256 与发布源一致 $NEW_SHA）"

step "等待新版本启动"
NEW_OK=0
for _ in $(seq 1 90); do
  if grep -q "init version=$NEW_VERSION " "$UPDATER_LOG" 2>/dev/null && xwininfo -root -tree 2>/dev/null | grep -q '"LULUX ETA"'; then NEW_OK=1; break; fi
  sleep 1
done
[[ "$NEW_OK" == "1" ]] && step "新版本 $NEW_VERSION 已启动（窗口已出现，updater 日志记录 init version=$NEW_VERSION）" || { echo "新版本没有自动启动"; }

step "发布源请求日志"
cat "$WORK/server.log"
step "updater.log"
cat "$UPDATER_LOG"
{
  echo "old=$(basename "$OLD") new=$NEW_NAME version=$NEW_VERSION"
  echo "downloaded+verified=yes replaced=yes relaunched=$([[ $NEW_OK == 1 ]] && echo yes || echo no)"
} >"$WORK/result.txt"
cat "$WORK/result.txt"
[[ "$NEW_OK" == "1" ]]
