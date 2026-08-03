#!/usr/bin/env bash
# Deploy ATLAS to the VPS.
#
# Ships EVERY package's src/ and package.json in one archive, rather than the
# handful of files a change happened to touch. That is not thoroughness for its
# own sake: on 2026-08-02 a piecemeal scp deploy left the server's
# packages/kdp/package.json missing @atlas/browser while its node_modules still
# had a stale link. The next `pnpm install` pruned the link to match, and ATLAS
# crash-looped in production. A second file, kdp/src/upload-steps.ts, turned out
# never to have been deployed at all.
#
# Syncing everything makes the server a copy of the repo instead of a slowly
# diverging cousin, and costs about 300 KB.
set -euo pipefail

HOST="${ATLAS_HOST:-root@72.62.168.207}"
KEY="${ATLAS_KEY:-$HOME/.ssh/atlas_deploy}"
APP="/opt/atlas/app"
ARCHIVE="$(mktemp -t atlas-deploy-XXXXXX).tgz"

cd "$(dirname "$0")/.."

echo "==> Verifying before shipping"
npx tsc -p tsconfig.json --noEmit
npx vitest run --silent

echo "==> Packing sources"
# Only src/ and manifests. Never data/ (live state) or node_modules.
tar -czf "$ARCHIVE" \
  $(for d in packages/*/; do [ -d "${d}src" ] && echo "${d}src"; done) \
  $(for d in packages/*/; do [ -f "${d}package.json" ] && echo "${d}package.json"; done) \
  package.json pnpm-lock.yaml pnpm-workspace.yaml

echo "==> Shipping $(du -h "$ARCHIVE" | cut -f1)"
scp -q -i "$KEY" -o StrictHostKeyChecking=no "$ARCHIVE" "$HOST:/tmp/atlas-deploy.tgz"
rm -f "$ARCHIVE"

echo "==> Extracting + installing"
ssh -i "$KEY" "$HOST" "
  set -e
  cd $APP
  tar -xzf /tmp/atlas-deploy.tgz
  rm -f /tmp/atlas-deploy.tgz
  # Install from a one-off container so it works even when atlas is crash-looping.
  docker run --rm -v $APP:/app \
    -v atlas_atlas_node_modules:/app/node_modules \
    -v atlas_atlas_pnpm_store:/root/.local/share/pnpm \
    -w /app node:22-bookworm sh -c 'corepack enable >/dev/null 2>&1 || true; pnpm install' 2>&1 | tail -3
  docker restart atlas >/dev/null
"

echo "==> Waiting for health"
for i in $(seq 1 12); do
  sleep 5
  # Same trap as the module-error check below: an outer `|| echo` appends a
  # SECOND line, so a failed curl reported "000000" instead of "000". Keep the
  # fallback inside the remote command, where it swallows the exit code
  # without adding output.
  code=$(ssh -i "$KEY" "$HOST" "curl -s -o /dev/null -w '%{http_code}' localhost:4317/api/health || true")
  if [ "$code" = "200" ]; then
    # A single 200 can land before a module error surfaces, so confirm the log
    # is clean too — that is exactly what the 2026-08-02 outage looked like.
    # `grep -c` exits 1 when the count is zero. Left to an outer `|| echo 0`
    # that appends a SECOND line, making errs "0\n0" — which never equals "0",
    # so a perfectly healthy deploy reported failure every time. The `|| true`
    # belongs inside the remote command, where it swallows grep's exit without
    # adding output.
    errs=$(ssh -i "$KEY" "$HOST" "docker logs --since 45s atlas 2>&1 | grep -ic ERR_MODULE_NOT_FOUND || true")
    if [ "$errs" = "0" ]; then echo "==> healthy (200, no module errors)"; exit 0; fi
    echo "    health 200 but $errs module error(s) — still settling"
  fi
  echo "    attempt $i: health=$code"
done

echo "!! DEPLOY FAILED — last logs:" >&2
ssh -i "$KEY" "$HOST" "docker logs --tail 30 atlas 2>&1" >&2
exit 1
