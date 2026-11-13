# Architecture

## Data flow

1. A scheduled refresh reads one or more operator-configured source profiles.
2. Each profile is processed sequentially, so one upstream provider is not hit by a burst of parallel requests.
3. Each response is parsed as Clash YAML, JSON, or a Base64/share-link list; normalized nodes retain protocol fields needed by Clash/Mihomo and sing-box output.
4. Nodes are normalized, renamed, structurally validated, deduplicated, and sorted per profile.
5. A canonical hash is calculated after normalization. This prevents an upstream reorder from being treated as a real change.
6. Each profile is published only when its valid-node threshold is met and its hash differs from its own last good version.
7. Each public URL serves only the last good generated state for its own profile and renders Clash/Mihomo, Base64 links, sing-box, or native Surge format according to the client or `target` parameter.
8. After the first successful fetch, the Worker sends `If-None-Match` / `If-Modified-Since` when validators are available; transient upstream failures use bounded retries, while invalid/empty responses fall back to the last valid D1 snapshot.
9. D1 snapshots are content-versioned, retention-pruned, and chunked before storage when the normalized node JSON is large.

## Deliberate safety properties

- An empty response, a parser error, or zero valid nodes cannot overwrite the last good version for that profile.
- A failed profile cannot overwrite or block another profile.
- A public client request never fetches the upstream source. This avoids leaking the source Token through timing or error responses and avoids multiplying upstream traffic.
- The Worker does not accept an arbitrary URL from the public request, which prevents the endpoint from becoming an open SSRF proxy.
- Logs contain only action, reason, and valid-node count.
- State is keyed by profile id and contains the generated output and its hash, not the original source URL.

## Current boundaries

Structural validity is not the same as live reachability. The current core checks protocol, host, port, and required credentials. Active TCP/proxy health checks are intentionally separate because they need a different security and resource model.

