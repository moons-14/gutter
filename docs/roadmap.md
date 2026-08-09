# Issue-ready roadmap

## M0 Foundation

- [ ] M0-1 Verify Compose test-profile smoke on a Docker-capable CI runner.
- [x] M0-2 Replace placeholder local PWA icon with original, local branded 192/512 raster assets.

## M1-M2 actionable backlog

- [ ] M1-1 Operator-configured allowed roots; reject symlinks and overlapping roots.
- [x] M1-2 Bounded CBZ/image-directory scanner with natural ordering and quarantine.
- [x] M1-3 ComicInfo tolerant metadata fallback and global admin hide state.
- [x] M2-1 Durable 15-minute reconcile and manual full scan, with optional default-off watcher hints.
- [x] M2-2 Rebuildable catalog hierarchy, exact credits, cursor list APIs, and mobile catalog UI.

The immutable library-root boundary foundation was delivered in
[`c360d85`](https://github.com/moons-14/gutter/commit/c360d85) / PR #13. The separate mutable,
authenticated admin registration follow-up remains open and is deferred to M5; it is not part of
the delivered foundation.

## Epics

- M3: source streaming, derived content-addressed cache, GC, and mobile reader modes/gestures. The
  internal worker reader stream is deliberately only a source-read primitive: no web reader UI,
  authentication, cache, or public source-path API is delivered by this boundary.
- M4: versioned metadata-provider HTTP sidecars and selected public API/PATs.
- M5: Better Auth passkey/TOTP, no-signup policy, library ACL, multi-user flows.
- M6: scale benchmark, operations, v1 API stabilization, backup/restore runbooks.
