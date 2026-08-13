# Public API v1

The selected public surface is [`openapi-v1.yaml`](./openapi-v1.yaml), under `/api/v1`.
Unlisted `/catalog`, `/user-state`, `/admin`, `/api/auth`, and `/api/reader` routes are internal.

Errors are `{ "error": "code", "requestId": "..." }`; compare-and-set progress conflicts include
the same `requestId`, and duplicate collection names return `409 collection_conflict` rather than a
null collection. Cursors are opaque and list limits are
30 by default, 100 maximum. JSON bodies are limited to 16 top-level properties and 256 KiB;
requests time out after 10 seconds. Clients should remain below 60 requests/minute per PAT.
Only the web/reverse-proxy service is exposed; API and worker stay on the private Compose network,
with TLS terminated at the proxy. PATs are bearer credentials scoped to v1: store only a hash,
show once, and support explicit revocation. No OAuth server or public admin API is provided.

V1 permits additive changes. Removing or narrowing a path, method, parameter, response, or enum
requires a new major version after deprecation. CI blocks removal against the previous artifact.
Reader pages preserve successful `200`/`206` binary bodies and conditional `304` responses. Reader
`409`, `416`, `499`, `500`, `503`, and `504` failures use the JSON error envelope; `416` also
preserves `Content-Range`.

The committed compatibility oracle is `docs/openapi-v1.baseline.json`; it is never generated from
the candidate. `docs/openapi-v1.yaml` is the reviewed source contract and
`docs/openapi-v1.json` is the served artifact; both must parse to exactly the same document. Run
`pnpm run check:openapi-compat` to compare baseline to candidate and verify served parity. To make
an intentional v1 contract change, review the source and served artifact together, run the negative
fixture suite (`pnpm exec tsx --test tests/openapi-compat.mts`), then replace the baseline with the
last reviewed release artifact in a separately reviewed commit. Never update the baseline from the
candidate as part of an ordinary CI run.

The focused runtime oracle is `pnpm test:public`. In CI it runs hermetic contract/proxy tests; the
Compose `public-api` profile runs the same suite against real PostgreSQL, the migrated API, and
Caddy (`docker compose --profile public-api run --rm public-api-test`).
For the published-path reader contract cases, point the API at the committed deterministic fixture:
`GUTTER_READER_SERVICE_URL=http://reader-fixture:3001 docker compose --profile public-api run --rm public-api-test`.
The fixture drives binary `200`/`206`, conditional `304`, range `416`, non-binary, and timeout cases
through Caddy; the normal default remains the private worker at `http://worker:3001`.
