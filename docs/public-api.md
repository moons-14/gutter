# Public API v1

The selected public surface is [`openapi-v1.yaml`](./openapi-v1.yaml), under `/api/v1`.
Unlisted `/catalog`, `/user-state`, `/admin`, `/api/auth`, and `/api/reader` routes are internal.

Errors are `{ "error": "code", "requestId": "..." }`. Cursors are opaque and list limits are
30 by default, 100 maximum. JSON bodies are limited to 16 top-level properties and 256 KiB;
requests time out after 10 seconds. Clients should remain below 60 requests/minute per PAT.
Only the web/reverse-proxy service is exposed; API and worker stay on the private Compose network,
with TLS terminated at the proxy. PATs are bearer credentials scoped to v1: store only a hash,
show once, and support explicit revocation. No OAuth server or public admin API is provided.

V1 permits additive changes. Removing or narrowing a path, method, parameter, response, or enum
requires a new major version after deprecation. CI blocks removal against the previous artifact.
