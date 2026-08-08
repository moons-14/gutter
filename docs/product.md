# Product decisions

`gutter` is a public MIT self-hosted comic library. Kavita and Mihon are behavior inspiration
only: no code, API, or database compatibility is intended. Files remain the read-only source of
truth: gutter will never edit, move, delete, rename, or repack source files. M0 has no catalog,
auth, reader, uploads, native app, Redis, or SaaS dependency. Supported future inputs are CBZ and
image directories only; CBR/7z, PDF, and EPUB are explicitly excluded.

The future domain is library → series → publication → release → page. CBZ and image directories
are inputs; ComicInfo has highest metadata priority but parsing is tolerant with fallbacks.
Scanning is recursive with natural order. Missing pages are skipped and an unreadable book is
quarantined. A watcher is only a hint; a 15-minute reconcile and manual full scan are required.
Path identity is initial; roots are operator configured, may not overlap, and may not contain
symlinks. Users/admins may hide items. Creators and groups are first-class future metadata.

Metadata providers are versioned HTTP sidecars. The client is a mobile Svelte PWA; Mihon-inspired
modes and gestures are later. There is no manga offline mode. Sources stream; derived content is a
content-addressed cache with GC. Future multi-user auth is Better Auth/passkey/TOTP plus library
ACL; there is no signup/email, and PATs cover selected public API only. APIs are internal and
unstable until v1.

Rationale and rejected alternatives: file source-of-truth prevents destructive library ownership;
a PWA is preferred to a native app; PostgreSQL plus pg-boss avoids a second queue/Redis service;
versioned HTTP sidecars isolate metadata providers instead of in-process plugins; no Kavita
compatibility prevents inherited constraints; and no manga offline mode avoids duplicating source
storage. These decisions map to M0-001/M0-002/M0-006/M0-008/M0-010 in
[`contracts.md`](contracts.md).
