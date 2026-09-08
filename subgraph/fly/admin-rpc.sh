#!/bin/bash
#
# Talk to graph-node's admin JSON-RPC, from inside the machine.
#
# From inside because there is nowhere else to do it from. graph-node binds 0.0.0.0 - IPv4
# only, confirmed in /proc/net/tcp6 on the running machine, where the sole listener is SSH -
# and Fly's private network is IPv6. `fly proxy` therefore reaches the machine and finds
# nothing listening. Fly's *public* proxy does reach IPv4, which is why queries on 8000 work
# and why this is not a problem for anyone reading the subgraph; it is only a problem for
# whoever deploys it.
#
# Publishing 8020 would solve it and must not: the admin RPC creates and deletes subgraphs
# and has no authentication of any kind.
#
# The graph-node image ships neither curl nor wget, so this speaks HTTP over bash's own TCP.
#
#   fly ssh console -a quorum402-subgraph -C "bash /admin-rpc.sh create <name>"
#   fly ssh console -a quorum402-subgraph -C "bash /admin-rpc.sh deploy <name> <ipfs-hash> <label>"
#
# Arguments are positional and the JSON is built here, so nothing has to survive two levels of
# shell quoting on the way in.
set -euo pipefail

rpc() {
  local body="$1"
  exec 3<>/dev/tcp/127.0.0.1/8020
  printf 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' \
    "${#body}" "$body" >&3
  # Headers and body both; the caller wants to see a non-200 as much as a result.
  cat <&3
  exec 3<&-
}

case "${1:-}" in
  create)
    name="${2:?usage: create <name>}"
    rpc "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"subgraph_create\",\"params\":{\"name\":\"$name\"}}"
    ;;
  deploy)
    name="${2:?usage: deploy <name> <ipfs-hash> <version-label>}"
    hash="${3:?usage: deploy <name> <ipfs-hash> <version-label>}"
    label="${4:?usage: deploy <name> <ipfs-hash> <version-label>}"
    rpc "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"subgraph_deploy\",\"params\":{\"name\":\"$name\",\"ipfs_hash\":\"$hash\",\"version_label\":\"$label\"}}"
    ;;
  remove)
    name="${2:?usage: remove <name>}"
    rpc "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"subgraph_remove\",\"params\":{\"name\":\"$name\"}}"
    ;;
  *)
    echo "usage: admin-rpc.sh (create <name> | deploy <name> <ipfs-hash> <label> | remove <name>)" >&2
    exit 2
    ;;
esac
