#!/usr/bin/env bash
#
# Push the subgraph to the graph-node running on Fly.
#
# `graph deploy` cannot do this in one step here. It wants to reach both IPFS and the admin
# RPC, and only one of those is reachable from a laptop: kubo is configured to listen on IPv6
# so `fly proxy` works, while graph-node binds IPv4 only and Fly's private network is IPv6, so
# a proxy to port 8020 connects to the machine and finds nothing. See admin-rpc.sh.
#
# So the deploy is split along that line. `graph build --ipfs` does the upload half over the
# proxy and prints the deployment hash; the admin half runs inside the machine.
#
#   ./fly/deploy-subgraph.sh v0.0.3
#
# Deploying the same content twice is harmless - the hash is the same, and graph-node treats
# it as the same deployment.
set -euo pipefail

label="${1:?usage: deploy-subgraph.sh <version-label>}"
app="${GRAPH_NODE_APP:-quorum402-subgraph}"
ipfs_app="${IPFS_APP:-quorum402-ipfs}"
name="${SUBGRAPH_NAME:-quorum402}"
port="${IPFS_PROXY_PORT:-15001}"

cd "$(dirname "$0")/.."

echo "==> opening a proxy to $ipfs_app"
flyctl proxy "$port:5001" -a "$ipfs_app" &
proxy=$!
trap 'kill "$proxy" 2>/dev/null || true' EXIT
until curl -sf -X POST "http://127.0.0.1:$port/api/v0/version" >/dev/null 2>&1; do sleep 1; done

echo "==> building and uploading"
# The hash is scraped rather than asked for, because `graph build` has no --json. It is the
# last "Build completed:" line, and the colour codes around it are why the pattern stops at
# the first non-alphanumeric character.
hash=$(npx graph build --ipfs "http://127.0.0.1:$port" | tee /dev/stderr |
  sed -n 's/.*Build completed: .\{0,8\}\(Qm[A-Za-z0-9]*\).*/\1/p' | tail -1)
[ -n "$hash" ] || { echo "could not read a deployment hash out of the build output" >&2; exit 1; }
echo "==> deployment $hash"

# The JSON body decides, not the exit status. `flyctl ssh console` on Windows prints
# "Error: The handle is invalid." and exits non-zero when the session closes, after the
# command it ran has already succeeded - so trusting the exit code here reports a failed
# deploy every time on one platform and a real failure on none.
admin() {
  local out
  out=$(flyctl ssh console -a "$app" -C "bash /admin-rpc.sh $*" 2>&1 || true)
  echo "$out"
  case "$out" in
    *'"result"'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Creating a name that already exists is an error and an expected one, so only the deploy is
# allowed to stop the script.
admin create "$name" || echo "    (already created - carrying on)"
admin deploy "$name" "$hash" "$label"

echo
echo "==> https://$app.fly.dev/subgraphs/name/$name"
