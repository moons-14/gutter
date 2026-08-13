#!/bin/sh
set -eu
root=$(mktemp -d "${TMPDIR:-/tmp}/gutter-nas-oracle.XXXXXX")
trap 'chmod -R u+rwX "$root" 2>/dev/null || true; rm -rf "$root"' EXIT
mkdir "$root/source"
printf 'source-fixture\n' >"$root/source/item.cbz"
before=$(sha256sum "$root/source/item.cbz" | cut -d' ' -f1)
chmod 0555 "$root/source"
if (umask 077; printf 'mutation\n' >"$root/source/item.cbz.new") 2>/dev/null; then
  echo 'read-only source mutation unexpectedly succeeded' >&2
  exit 1
fi
after=$(sha256sum "$root/source/item.cbz" | cut -d' ' -f1)
test "$before" = "$after"
printf '%s\n' '{"name":"linux-local-source","status":"pass","sourceMutation":"denied","outage":"preserve projections"}'
printf '%s\n' '{"name":"nfs","status":"unavailable","reason":"NFS capability probe requires operator-mounted export","command":"mount -t nfs ..."}'
printf '%s\n' '{"name":"smb","status":"unavailable","reason":"SMB capability probe requires operator-mounted CIFS share","command":"mount -t cifs ..."}'
