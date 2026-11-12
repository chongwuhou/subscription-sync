# Architecture

## Data flow

1. A scheduled refresh reads the single operator-configured source URL.
2. The response is parsed as Clash YAML, JSON, or a Base64/share-link list.
3. Nodes are normalized, renamed, structurally validated, deduplicated, and sorted.
4. A canonical hash is calculated after normalization. This prevents an upstream reorder from being treated as a real change.
5. The new result is published only when the valid-node threshold is met and the hash differs from the last good version.
6. The public URL serves only the last good generated Clash YAML.

## Deliberate safety properties

- An empty response, a parser error, or zero valid nodes cannot overwrite the last good version.
- A public client request never fetches the upstream source. This avoids leaking the source Token through timing or error responses and avoids multiplying upstream traffic.
- The Worker does not accept an arbitrary URL from the public request, which prevents the endpoint from becoming an open SSRF proxy.
- Logs contain only action, reason, and valid-node count.
- State contains the generated output and its hash, not the original source URL.

## Current boundaries

Structural validity is not the same as live reachability. The current core checks protocol, host, port, and required credentials. Active TCP/proxy health checks are intentionally separate because they need a different security and resource model.

