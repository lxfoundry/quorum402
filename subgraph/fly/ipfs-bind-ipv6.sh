# Bind the kubo API and gateway to IPv6.
#
# Fly's private network is IPv6 only - quorum402-ipfs.internal resolves to an fdaa:: address -
# and kubo's docker entrypoint binds the API to 0.0.0.0, which is IPv4. graph-node would
# resolve the name, connect to nothing, and report the subgraph as failed to start with no
# hint that the address family was the problem.
#
# Sourced by kubo's entrypoint from /container-init.d, after the repo is initialised and
# before the daemon starts.
ipfs config Addresses.API /ip6/::/tcp/5001
ipfs config Addresses.Gateway /ip6/::/tcp/8080
