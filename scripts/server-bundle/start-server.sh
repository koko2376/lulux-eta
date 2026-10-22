#!/usr/bin/env sh
# 不用 Docker 直接运行团队服务器 / Run the team server with plain Node.js (22.13+), no Docker.
#   LULUX_PUBLIC_ORIGIN=https://lulux.example.com ./start-server.sh
# 其他变量见 README-server.md / See README-server.md for the other variables.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
: "${LULUX_PUBLIC_ORIGIN:?请设置 LULUX_PUBLIC_ORIGIN / set LULUX_PUBLIC_ORIGIN, e.g. https://lulux.example.com}"
export NODE_ENV="${NODE_ENV:-production}"
export LULUX_MODE=server
export LULUX_ETA_HOME="${LULUX_ETA_HOME:-$here/data}"
export LULUX_ETA_HOST="${LULUX_ETA_HOST:-127.0.0.1}"
export LULUX_ETA_PORT="${LULUX_ETA_PORT:-51789}"
export LULUX_ETA_CLIENT_DIST="${LULUX_ETA_CLIENT_DIST:-$here/client}"
export LULUX_TRUST_PROXY="${LULUX_TRUST_PROXY:-1}"
export NODE_OPTIONS="${NODE_OPTIONS:---disable-warning=ExperimentalWarning}"
mkdir -p "$LULUX_ETA_HOME"
cd "$here/server"
exec node dist/index.js "$@"
