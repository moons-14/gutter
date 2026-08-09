# API

Keep this internal-only service small: request ID, redacted Pino JSON logs, Prometheus metrics,
OpenAPI, liveness, readiness, and M2 read-only catalog routes. M5 supersedes the former
authentication prohibition only for the local Better Auth boundary at `/api/auth`; retain no source
mutation or reader endpoints here. Do not add external identity providers or hosted auth services.
