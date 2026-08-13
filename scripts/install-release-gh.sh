#!/bin/sh
set -eu

version=${RELEASE_GH_VERSION:?set RELEASE_GH_VERSION to the reviewed GitHub CLI version}
archive_sha256=${RELEASE_GH_ARCHIVE_SHA256:?set RELEASE_GH_ARCHIVE_SHA256 to the reviewed archive digest}
destination=${1:?usage: install-release-gh.sh ABSOLUTE_EMPTY_DESTINATION}

case "$version" in *[!0-9.]*|'') echo 'RELEASE_GH_VERSION is malformed' >&2; exit 2 ;; esac
case "$archive_sha256" in *[!0-9a-f]*|'') invalid_digest=1 ;; *) invalid_digest=0 ;; esac
if [ "$invalid_digest" -eq 1 ] || [ "${#archive_sha256}" -ne 64 ]; then
  echo 'RELEASE_GH_ARCHIVE_SHA256 must be a lowercase SHA-256 digest' >&2
  exit 2
fi
case "$destination" in /tmp/*|/home/runner/work/_temp/*) ;; *) echo 'destination must be under a disposable runner directory' >&2; exit 2 ;; esac
if [ -e "$destination" ] || [ -L "$destination" ]; then
  echo 'destination must not already exist' >&2
  exit 2
fi

mkdir -p "$destination"
archive="$destination/gh.tar.gz"
url="https://github.com/cli/cli/releases/download/v$version/gh_${version}_linux_amd64.tar.gz"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --output "$archive" "$url"
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum -c -
tar -xzf "$archive" -C "$destination" --strip-components=2 "gh_${version}_linux_amd64/bin/gh"
test -f "$destination/gh"
test ! -L "$destination/gh"
chmod 0555 "$destination/gh"
"$destination/gh" version | grep -F "gh version $version " >/dev/null
printf '%s\n' "$destination/gh"
