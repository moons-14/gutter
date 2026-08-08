# gutter

MIT-licensed, self-hosted comic-library foundation. It is intentionally M0 only: no catalog,
authentication, or reader is implemented.

## Linux quickstart

Install Docker Compose, set an explicit development password, and start the stack:

```sh
read -rs POSTGRES_PASSWORD
export POSTGRES_PASSWORD
docker compose up --build
```

Only the web service is published (`http://localhost:8080`). The web reverse-proxies `/api` to
the internal API. Run `docker compose --profile test run --rm test` for the live-stack smoke
after `docker compose up -d db migrate api web`.

For production, Docker Compose v2.24.4 or newer is required for the reset tags in the overlay.
Create non-committed `secrets/postgres_password` and `secrets/database_url`, then run:

```sh
docker compose -f compose.yaml -f compose.production.example.yaml up --build
```

The overlay removes the direct development variables before PostgreSQL consumes its official
`POSTGRES_PASSWORD_FILE` and API, worker, and migrate consume `DATABASE_URL_FILE`. The values are
mandatory at runtime: use either direct development values or the file variants, never both.

For NAS libraries, mount NFS/SMB on the host and bind only that host mount into `worker`:

```sh
sudo mount -t nfs nas:/comics /mnt/comics
# Add /mnt/comics:/libraries/comics:ro to worker.volumes in compose.yaml.
```

Do not mount remote storage in API containers. Restore PostgreSQL only with an operator-managed
`pg_dump`/`pg_restore` workflow while the application is stopped; M0 does not automate restore.
Put Caddy/Nginx or Tailscale in front of port 8080 for remote access. TLS, auth, catalog scans,
and reader streaming are later milestones.
