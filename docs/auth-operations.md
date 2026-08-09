# Authentication operations

`BETTER_AUTH_SECRET_FILE` is mandatory. Generate at least 32 random bytes, store the file outside
version control, and mount it only into `api`. The production Compose example uses Docker secrets.
Set `GUTTER_AUTH_ORIGIN` and Caddy's `GUTTER_SITE_ADDRESS` to the same externally visible HTTPS
origin. Caddy is the sole supported public ingress and TLS terminator: publish its ports 80 and
443 directly and do not put a TLS proxy or CDN in front of it. Caddy overwrites client-supplied
`X-Forwarded-For` with the directly observed peer. Compose assigns Caddy the fixed internal
address `172.30.0.20`, which is the only trusted forwarded-IP proxy for the API; do not broaden
`GUTTER_AUTH_TRUSTED_PROXIES_JSON`. The production example persists Caddy's `/data` and `/config`
volumes so certificates and state survive replacement. HTTP is accepted solely for localhost
bootstrap; non-local origins are rejected at startup and use Secure cookies.

On a new database, POST `/api/auth/bootstrap` once with Better Auth's email/password signup body.
That request atomically consumes the bootstrap claim and creates the first account with the `admin`
role. `/api/auth/sign-up/email` is always rejected by Gutter, so later accounts require an admin
flow (not yet exposed in the browser UI).

For local operator recovery, revoke all sessions without changing credentials:

`pnpm --filter @gutter/api auth revoke-sessions admin@example.invalid`

`pnpm --filter @gutter/api auth disable-user user@example.invalid` disables an account and revokes
its sessions; `enable-user` reverses the disable. A crash after a bootstrap claim but before account
creation is recoverable only on a still-empty database with `pnpm --filter @gutter/api auth
reset-bootstrap`; it cannot reopen registration once an account exists.

Back up PostgreSQL and the versioned Better Auth secret together. The authentication tables
(`user`, `session`, `account`, `verification`, `twoFactor`, and `passkey`) contain password hashes,
encrypted TOTP/recovery material, and WebAuthn public keys. Restore the database and every current
and retained previous secret atomically; restoring only one can invalidate sessions or make TOTP
recovery data undecryptable. Test a restore in an isolated deployment before replacing a live one.
