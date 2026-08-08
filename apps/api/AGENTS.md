# API

Keep this internal-only service small: request ID, redacted Pino JSON logs, Prometheus metrics,
OpenAPI, liveness, readiness, and M2 read-only catalog routes. No authentication, source mutation,
or reader endpoints.
