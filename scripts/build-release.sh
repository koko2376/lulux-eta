#!/usr/bin/env bash
# LULUX ETA 发布构建：一条命令出 Windows x64 安装包（NSIS）+ Linux AppImage（x64 / arm64）[+ macOS，仅在 macOS 主机上]，
# 产物与自动更新元数据（latest.yml / latest-linux.yml / latest-linux-arm64.yml [/ latest-mac.yml] 与 *.blockmap）、
# SHA256SUMS.txt、BUILDINFO.txt 放到输出目录。自动更新说明见 docs/AUTO-UPDATE.md。
#
#   scripts/build-release.sh                      # 默认：win + linux(x64,arm64)，输出 ../dist-out
#   scripts/build-release.sh --targets linux      # 只打 Linux
#   scripts/build-release.sh --linux-archs x64    # Linux 只打 x64
#   scripts/build-release.sh --out /path/to/out --smoke   # 打完在本机架构的 AppImage 上跑 Xvfb 冒烟
#   scripts/build-release.sh --ci                 # 先 npm ci --include=dev
#
# 环境变量：
#   LULUX_BUILD_DIR   electron-builder 中间产物目录（默认 ../build-tmp；不要放在内存盘 /tmp，mksquashfs 会 OOM）
#   LULUX_UPDATE_REPO owner/repo：写入安装包的自动更新源（覆盖 electron-builder.yml 里的 koko2376/lulux-eta）
#   CSC_LINK / CSC_KEY_PASSWORD   有证书时自动签名（Windows 需在 Windows 主机或可用 wine 的 x64 Linux 上签）
#
# 在非 Windows 主机上交叉打 Windows 包：
#   - x64 Linux：electron-builder 自带的 NSIS 3.0.4.1 直接可用；装了 wine 时用 rcedit 写 exe 图标/版本并可签名。
#   - arm64 Linux：NSIS 3.0.4.1 的 linux/makensis 是 x86-64 程序，用 box64 运行（sudo apt install box64）；
#     没有 box64 时退回系统 NSIS（sudo apt install nsis，版本不同于官方固定版本，会提示）。
#   - 没有可用 wine 时：scripts/cross/wine 替身只负责从“卸载程序生成器”中解出 uninstaller（nsis-uninstaller.cjs），
#     exe 图标与版本信息由 packages/desktop/scripts/after-pack.cjs 用 resedit 写入（此时无法 Authenticode 签名）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/packages/desktop"
OUT="$(cd "$ROOT/.." && pwd)/dist-out"
BUILD_DIR="${LULUX_BUILD_DIR:-$(cd "$ROOT/.." && pwd)/build-tmp}"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
TARGETS="win linux"
[[ "$HOST_OS" == "Darwin" ]] && TARGETS="mac win linux"
LINUX_ARCHS="x64 arm64"
SMOKE=0
CI_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --targets) TARGETS="$2"; shift 2 ;;
    --linux-archs) LINUX_ARCHS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --smoke) SMOKE=1; shift ;;
    --ci) CI_INSTALL=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1;34m[release]\033[0m %s\n' "$*"; }
EB=(npx --no-install electron-builder --config electron-builder.yml --publish never)
UPDATE_REPO="${LULUX_UPDATE_REPO:-}"
if [[ -n "$UPDATE_REPO" ]]; then
  [[ "$UPDATE_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "LULUX_UPDATE_REPO 应为 owner/repo：$UPDATE_REPO" >&2; exit 2; }
  EB+=(-c.publish.provider=github -c.publish.owner="${UPDATE_REPO%%/*}" -c.publish.repo="${UPDATE_REPO#*/}")
fi
UPDATE_SOURCE="${UPDATE_REPO:-$(sed -n 's/^  owner: *//p' "$DESKTOP/electron-builder.yml" | head -1)/$(sed -n 's/^  repo: *//p' "$DESKTOP/electron-builder.yml" | head -1)}"

cd "$ROOT"
if [[ "$CI_INSTALL" == "1" ]]; then
  log "npm ci --include=dev"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --include=dev --no-audit --no-fund
fi
[[ -d node_modules/electron-builder && -d node_modules/npm ]] || { echo "缺少依赖：先运行 npm ci --include=dev（或加 --ci）" >&2; exit 1; }

VERSION="$(node -p "require('./packages/desktop/package.json').version")"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git status --porcelain 2>/dev/null | grep -c . || true)"

log "构建 server / client / desktop（版本 $VERSION，提交 $COMMIT，未提交改动 $DIRTY 个文件）"
npm run build -w @lulux/server
npm run build -w @lulux/client
npm run predist -w @lulux/desktop

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$OUT"
ARTIFACTS=()

# ── Windows ────────────────────────────────────────────────────────────────
build_win() {
  local out="$BUILD_DIR/win" extra=() env=()
  if [[ "$HOST_OS" != MINGW* && "$HOST_OS" != MSYS* && "$HOST_OS" != CYGWIN* ]]; then
    # NSIS
    if [[ "$HOST_ARCH" == "aarch64" || "$HOST_ARCH" == "arm64" ]] && [[ "$HOST_OS" == "Linux" ]]; then
      local nsis
      nsis="$(prepare_nsis_arm64)"
      [[ -n "$nsis" && -x "$nsis/linux/makensis" ]] || { echo "准备 NSIS 失败" >&2; exit 1; }
      env+=("ELECTRON_BUILDER_NSIS_DIR=$nsis")
    fi
    # wine：x64 主机上有可用 wine 就用真的（rcedit + 可签名），否则用替身
    if [[ "$HOST_ARCH" == "x86_64" ]] && command -v wine >/dev/null 2>&1 && wine --version >/dev/null 2>&1; then
      log "Windows：使用本机 wine（$(wine --version)）"
    else
      log "Windows：没有可用 wine → uninstaller 由 scripts/cross/nsis-uninstaller.cjs 解出，exe 资源由 resedit 写入（不签名）"
      env+=("PATH=$ROOT/scripts/cross:$PATH" "LULUX_NSIS_UNINSTALLER_OUT=$out/__uninstaller-nsis-@luluxdesktop.exe")
      extra+=(-c.win.signAndEditExecutable=false)
    fi
  fi
  log "electron-builder --win nsis --x64"
  (cd "$DESKTOP" && env BOX64_LOG=0 BOX64_NOBANNER=1 "${env[@]}" "${EB[@]}" --win nsis --x64 -c.directories.output="$out" "${extra[@]}")
  ARTIFACTS+=("$out"/LULUX-ETA-"$VERSION"-win-x64-setup.exe)
  # 自动更新：latest.yml + 安装包 blockmap（差分下载）
  ARTIFACTS+=("$out"/latest.yml "$out"/LULUX-ETA-"$VERSION"-win-x64-setup.exe.blockmap)
  rm -rf "$out/win-unpacked"
}

# arm64 Linux：官方 NSIS 3.0.4.1 包（与 electron-builder 内置相同，校验 sha512）+ box64 运行其 x86-64 makensis
prepare_nsis_arm64() {
  local dir="$BUILD_DIR/nsis" archive="$BUILD_DIR/nsis-3.0.4.1.7z"
  local url="https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z"
  local sha512="VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q=="
  local z7="$ROOT/node_modules/7zip-bin/linux/arm64/7za"
  if command -v box64 >/dev/null 2>&1; then
    curl -fsSL -o "$archive" "$url"
    [[ "$(openssl dgst -sha512 -binary "$archive" | base64 -w0)" == "$sha512" ]] || { echo "NSIS 包校验失败" >&2; exit 1; }
    chmod +x "$z7"
    "$z7" x -y -o"$dir" "$archive" >/dev/null
    mv "$dir/linux/makensis" "$dir/linux/makensis.x64"
    printf '#!/bin/sh\nexec box64 "$(dirname "$0")/makensis.x64" "$@"\n' >"$dir/linux/makensis"
    chmod +x "$dir/linux/makensis"
    echo "[release] NSIS 3.0.4.1（box64）" >&2
  elif command -v makensis >/dev/null 2>&1; then
    # 退路：系统 NSIS + 官方包里的 elevate.exe / nsisconf.nsh
    mkdir -p "$dir/linux"
    ln -sf "$(command -v makensis)" "$dir/linux/makensis"
    for d in Stubs Include Contrib Plugins Bin; do ln -sfn "/usr/share/nsis/$d" "$dir/$d"; done
    curl -fsSL -o "$archive" "$url" && chmod +x "$z7" && "$z7" e -y -o"$dir" "$archive" elevate.exe nsisconf.nsh >/dev/null
    echo "[release] 警告：没有 box64，使用系统 NSIS $(makensis -VERSION)（非 electron-builder 固定的 3.0.4.1）" >&2
  else
    echo "arm64 上打 Windows 包需要 box64（推荐）或 nsis：sudo apt install box64" >&2
    exit 1
  fi
  echo "$dir"
}

# ── Linux ──────────────────────────────────────────────────────────────────
build_linux() {
  local arch
  for arch in $LINUX_ARCHS; do
    local out="$BUILD_DIR/linux-$arch" name
    log "electron-builder --linux AppImage --$arch"
    (cd "$DESKTOP" && "${EB[@]}" --linux AppImage --"$arch" -c.directories.output="$out")
    name="$(ls "$out"/LULUX-ETA-"$VERSION"-linux-*.AppImage | head -1)"
    ARTIFACTS+=("$name")
    # 自动更新：latest-linux.yml（x64）/ latest-linux-arm64.yml；AppImage 的 blockmap 内嵌在文件末尾（yml 里的 blockMapSize），
    # 若 electron-builder 另外输出了 .blockmap 也一并带上
    ARTIFACTS+=("$out"/latest-linux*.yml)
    shopt -s nullglob; local bm=("$out"/*.AppImage.blockmap); shopt -u nullglob
    ARTIFACTS+=("${bm[@]}")
    rm -rf "$out"/linux-*unpacked "$out"/__appImage-*
  done
}

# ── macOS（只能在 macOS 上打；没有证书时产出未签名包）───────────────────────
build_mac() {
  if [[ "$HOST_OS" != "Darwin" ]]; then
    log "跳过 macOS：需要在 macOS 主机上构建（配置见 packages/desktop/electron-builder.yml 的 mac/dmg 段）"
    return
  fi
  local out="$BUILD_DIR/mac"
  [[ -z "${CSC_LINK:-}" ]] && export CSC_IDENTITY_AUTO_DISCOVERY=false
  log "electron-builder --mac dmg zip --arm64 --x64"
  (cd "$DESKTOP" && "${EB[@]}" --mac dmg zip --arm64 --x64 -c.directories.output="$out")
  ARTIFACTS+=("$out"/*.dmg "$out"/*.zip "$out"/*.blockmap "$out"/latest-mac.yml)
}

for target in $TARGETS; do
  case "$target" in
    win) build_win ;;
    linux) build_linux ;;
    mac) build_mac ;;
    *) echo "未知目标：$target" >&2; exit 2 ;;
  esac
done

# ── 汇总 ───────────────────────────────────────────────────────────────────
log "复制产物到 $OUT"
for file in "${ARTIFACTS[@]}"; do cp -f "$file" "$OUT/"; done
(
  cd "$OUT"
  shopt -s nullglob
  files=(LULUX-ETA-"$VERSION"-*.exe LULUX-ETA-"$VERSION"-*.AppImage LULUX-ETA-"$VERSION"-*.dmg LULUX-ETA-"$VERSION"-*.zip)
  # 只保留本次版本的更新元数据（输出目录里可能有旧版本残留）
  for y in latest*.yml; do grep -q "^version: $VERSION\$" "$y" || { echo "移除旧版本更新元数据 $y" >&2; rm -f "$y"; }; done
  updates=(latest*.yml LULUX-ETA-"$VERSION"-*.blockmap)
  sha256sum "${files[@]}" "${updates[@]}" >SHA256SUMS.txt
  {
    echo "LULUX ETA $VERSION"
    echo "commit: $COMMIT (uncommitted files at build time: $DIRTY)"
    echo "built: $(node -p "new Date().toISOString()") on $HOST_OS-$HOST_ARCH"
    echo "electron: $(node -p "require('$ROOT/node_modules/electron/package.json').version")  bundled npm: $(node -p "require('$ROOT/node_modules/npm/package.json').version")"
    echo "signed: no (see docs/INSTALL.md)"
    echo "update source: github $UPDATE_SOURCE$([[ "$UPDATE_SOURCE" == OWNER/* ]] && echo ' (placeholder: auto-update disabled in this build)')"
    echo
    echo "size (bytes)  file"
    for f in "${files[@]}" "${updates[@]}"; do printf '%12s  %s\n' "$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")" "$f"; done
  } >BUILDINFO.txt
  cat BUILDINFO.txt
  echo
  cat SHA256SUMS.txt
)

if [[ "$SMOKE" == "1" && "$HOST_OS" == "Linux" ]]; then
  case "$HOST_ARCH" in x86_64) a=x86_64 ;; aarch64) a=arm64 ;; *) a="$HOST_ARCH" ;; esac
  image="$OUT/LULUX-ETA-$VERSION-linux-$a.AppImage"
  if [[ -f "$image" ]]; then
    log "冒烟：$image"
    "$ROOT/scripts/smoke-appimage.sh" "$image" "$OUT/smoke-linux-$a.png"
  fi
fi
log "完成"
