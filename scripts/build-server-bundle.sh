#!/usr/bin/env bash
# Packs the team server into a self-contained tarball:  dist-server/lulux-eta-server-<tag>.tar.gz
# Used by .github/workflows/release.yml (job "server"); runnable locally.
#
# Prerequisite: server and client are already built
#   npm run build -w @lulux/server && npm run build -w @lulux/client
#
# Usage: scripts/build-server-bundle.sh <tag> [image]
#   tag    e.g. v0.1.1 (default: v<version from package.json>)
#   image  container image written into the bundled docker-compose.yml
#          (default: ghcr.io/owner/lulux-eta:<version>; CI passes the real lowercase owner)
#
# Layout (mirrors the Docker image, so the same paths work in both):
#   lulux-eta-server-<tag>/
#     server/{package.json,dist/,skills/}   client/ (built web UI)   node_modules/ (production deps only)
#     Dockerfile (runtime-only, builds from this bundle)   docker-compose.yml   deploy/   start-server.sh
#     README-server.md   LICENSE   NOTICE   THIRD_PARTY_LICENSES.md
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="$(node -p "require('./package.json').version")"
tag="${1:-v$version}"
image="${2:-ghcr.io/owner/lulux-eta:${tag#v}}"
name="lulux-eta-server-$tag"
out="$root/dist-server"
stage="$out/$name"

[ -f packages/server/dist/index.js ] || { echo "packages/server/dist missing: build @lulux/server first" >&2; exit 1; }
[ -f packages/client/dist/index.html ] || { echo "packages/client/dist missing: build @lulux/client first" >&2; exit 1; }

rm -rf "$stage" "$out/$name.tar.gz"
mkdir -p "$stage/server" "$stage/deploy"

# ── server + client ──────────────────────────────────────────────────────
cp packages/server/package.json "$stage/server/"
cp -R packages/server/dist "$stage/server/dist"
cp -R packages/server/skills "$stage/server/skills"
cp -R packages/client/dist "$stage/client"

# ── production node_modules (lockfile-based, same as the Dockerfile "deps" stage) ──
deps="$(mktemp -d)"
trap 'rm -rf "$deps"' EXIT
cp package.json package-lock.json "$deps/"
for p in server client desktop; do
  mkdir -p "$deps/packages/$p"
  cp "packages/$p/package.json" "$deps/packages/$p/"
done
(cd "$deps" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @lulux/server >/dev/null)
# workspace links point back into packages/* and would dangle in the bundle
rm -rf "$deps/node_modules/@lulux" "$deps/node_modules/.package-lock.json"
# npm keeps root "devOptional" packages (e.g. typescript) even with --omit=dev; drop the ones no installed package uses
(cd "$deps" && node -e '
const fs = require("fs"), path = require("path")
const lock = require("./package-lock.json").packages
const nm = "node_modules", used = new Set()
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name === ".bin") continue
  const p = path.join(dir, e.name)
  if (e.name.startsWith("@")) { walk(p); continue }
  try { const j = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8"))
    for (const k of ["dependencies", "optionalDependencies", "peerDependencies"]) Object.keys(j[k] || {}).forEach((d) => used.add(d)) } catch {}
  if (fs.existsSync(path.join(p, nm))) walk(path.join(p, nm)) } }
walk(nm)
Object.keys(require("./packages/server/package.json").dependencies || {}).forEach((d) => used.add(d))
for (const [k, v] of Object.entries(lock)) {
  if (!k.startsWith(nm + "/") || k.indexOf("/" + nm + "/") > 0 || !v.devOptional) continue
  const name = k.slice(nm.length + 1)
  if (!used.has(name) && fs.existsSync(k)) { fs.rmSync(k, { recursive: true, force: true }); console.error("pruned " + name) }
}')
find "$deps/node_modules" -xtype l -delete
find "$deps/node_modules" -mindepth 1 -type d -empty -delete
mv "$deps/node_modules" "$stage/node_modules"

# ── deployment files ─────────────────────────────────────────────────────
cp LICENSE NOTICE THIRD_PARTY_LICENSES.md "$stage/"
cp deploy/Caddyfile deploy/env.example deploy/nginx.conf.example "$stage/deploy/"
cp scripts/server-bundle/README-server.md "$stage/README-server.md"
cp scripts/server-bundle/Dockerfile "$stage/Dockerfile"
cp scripts/server-bundle/start-server.sh "$stage/start-server.sh"
chmod +x "$stage/start-server.sh"
# compose: same service definition as the repo, but the image is the published one and `build: .` uses the bundle Dockerfile
sed -e "s|^    image: lulux-eta-server:local\$|    image: \${LULUX_IMAGE:-$image}|" \
    -e 's|docker compose up -d --build |docker compose pull \&\& docker compose up -d |' \
    -e 's|docker compose --profile caddy up -d --build |docker compose --profile caddy pull \&\& docker compose --profile caddy up -d |' \
    docker-compose.yml > "$stage/docker-compose.yml"
grep -q "image: \${LULUX_IMAGE:-$image}" "$stage/docker-compose.yml" || { echo "failed to set the image in docker-compose.yml" >&2; exit 1; }
sed -i "s|@IMAGE@|$image|g; s|@TAG@|$tag|g" "$stage/README-server.md"

# ── tarball (reproducible-ish: fixed owner, sorted) ──────────────────────
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$out" -czf "$out/$name.tar.gz" "$name"
rm -rf "$stage"
echo "$out/$name.tar.gz"
