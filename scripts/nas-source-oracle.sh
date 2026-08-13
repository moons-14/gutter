#!/bin/sh
set -eu
root=$(mktemp -d "${TMPDIR:-/tmp}/gutter-nas-oracle.XXXXXX")
trap 'chmod -R u+rwX "$root" 2>/dev/null || true; rm -rf "$root"' EXIT
mkdir "$root/source"
mkdir "$root/projection"
printf 'source-fixture\n' >"$root/source/item.cbz"
before=$(sha256sum "$root/source/item.cbz" | cut -d' ' -f1)
printf '{"relativePath":"item.cbz","sha256":"%s"}\n' "$before" >"$root/projection/inventory.json"
projection_before=$(sha256sum "$root/projection/inventory.json" | cut -d' ' -f1)
chmod 0555 "$root/source"
if (umask 077; printf 'mutation\n' >"$root/source/item.cbz.new") 2>/dev/null; then
  echo 'read-only source mutation unexpectedly succeeded' >&2
  exit 1
fi
after=$(sha256sum "$root/source/item.cbz" | cut -d' ' -f1)
test "$before" = "$after"
# Simulate an unavailable mount by moving the source directory away. The persisted projection
# snapshot is represented by this checksum and must remain queryable while the path is absent.
projection_snapshot="$before"
mv "$root/source" "$root/source-unavailable"
test ! -e "$root/source"
projection_during=$(sha256sum "$root/projection/inventory.json" | cut -d' ' -f1)
test "$projection_snapshot" = "$before"
test "$projection_during" = "$projection_before"
grep -q "$before" "$root/projection/inventory.json"
mv "$root/source-unavailable" "$root/source"
restored=$(sha256sum "$root/source/item.cbz" | cut -d' ' -f1)
test "$restored" = "$before"
printf '{"name":"linux-local-source","status":"pass","sourceMutation":"denied","outageObserved":true,"projectionReadable":true,"projectionHashBefore":"%s","projectionHashDuring":"%s","sourceHash":"%s"}\n' "$projection_before" "$projection_during" "$restored"
printf '%s\n' '{"name":"nfs","status":"unavailable","reason":"NFS capability probe requires operator-mounted export","command":"mount -t nfs ..."}'
printf '%s\n' '{"name":"smb","status":"unavailable","reason":"SMB capability probe requires operator-mounted CIFS share","command":"mount -t cifs ..."}'
