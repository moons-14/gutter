# Product decisions

`gutter` is a public MIT self-hosted comic-library foundation. Files are read-only source material:
the application never edits, moves, deletes, renames, or repacks them. M1 lets an operator declare
up to 64 immutable container paths. The worker validates those paths in its own mount namespace and
persists a PostgreSQL availability snapshot (`ready_nonempty`, `ready_empty`, `missing`,
`unreadable`, `not_directory`, or `unavailable`) and a rebuildable read-only inventory.

Discovery is a bounded DFS of CBZ archives and innermost directories with direct supported image
files. It reads optional local ComicInfo metadata without changing source authority. Changed items
are subsequently validated read-only: JPEG, PNG, WebP, and GIF first frames are fully decoded and
CBZ page CRCs are compared; AVIF is unsupported in M1 (future best-effort work), and bad pages are skipped. Malformed, unsafe, encrypted, over-limit, empty,
and duplicate-locator archives are quarantined. The delivered S20-1 reader foundation is an opaque,
network-only worker descriptor/page boundary with a minimal descriptor-gated shell. Reader
interactions, gestures, prefetch, and browser-local progress/preferences remain pending; there is no
auth, upload, mutable registration endpoint/UI, or external metadata provider. A configured root is
not a published library.

M2 presents that source inventory as a mobile-first, trusted-LAN catalog: libraries, series,
publications, releases, and creator/group/publisher pages. `ComicInfo.xml` overrides inferred
title/series metadata; exact normalized identity avoids fuzzy merges. Multiple physical releases
may represent one publication. A durable global preferred release uses root plus publication
identity and source-item ID; it becomes dormant when its source is hidden and returns if visible
again. Catalog state may be rebuilt from source inventory and metadata; user-specific reading,
hiding, and preferences are deliberately not present yet.

The product boundary preserves future options while preventing source ownership: roots cannot be
`/`, overlap, or resolve through symlinks; the API has no library mount; and worker binds are
explicit and read-only. PostgreSQL plus pg-boss continues to avoid a second queue/Redis service.
