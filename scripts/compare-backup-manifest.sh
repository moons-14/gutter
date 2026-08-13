#!/bin/sh
set -eu
: "${1:?usage: compare-backup-manifest.sh MANIFEST TOC}"
: "${2:?usage: compare-backup-manifest.sh MANIFEST TOC}"
manifest=$1
toc=$2
test -f "$manifest" || { echo 'manifest not found' >&2; exit 2; }
test -f "$toc" || { echo 'TOC not found' >&2; exit 2; }
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/gutter-manifest-compare.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT INT TERM

# Keep this parser deliberately POSIX: it runs in the postgres image, which has awk but no Node.
# It accepts ordinary identifiers and SQL-quoted identifiers (including doubled quotes/spaces),
# rejects malformed/blank/duplicate entries, and emits one canonical C-sorted name per line.
awk '
function fail(message) { print message > "/dev/stderr"; bad=1; exit 1 }
function trim(value) { sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); return value }
function identifier(value,    i,c,n,out,nextc) {
  value=trim(value); n=length(value); if (!n) fail("manifest contains a blank entry")
  if (substr(value,1,1)=="\"") {
    out=""; i=2
    while (i<=n) {
      c=substr(value,i,1)
      if (c=="\"") {
        nextc=(i<n ? substr(value,i+1,1) : "")
        if (nextc=="\"") { out=out "\""; i+=2; continue }
        if (trim(substr(value,i+1))!="") fail("quoted identifier has trailing text")
        if (out=="") fail("quoted identifier is empty")
        return out
      }
      out=out c; i++
    }
    fail("unterminated quoted identifier")
  }
  if (value !~ /^[A-Za-z_][A-Za-z0-9_$]*$/) fail("invalid identifier")
  return value
}
{
  line=trim($0)
  if (line=="") fail("manifest contains a blank entry")
  name=identifier(line)
  if (seen[name]++) fail("manifest contains duplicate entries")
  print name
}
END { if (NR==0) { print "manifest is empty" > "/dev/stderr"; exit 1 } }
' "$manifest" > "$tmpdir/manifest.raw"
LC_ALL=C sort "$tmpdir/manifest.raw" > "$tmpdir/expected"

awk '
function fail(message) { print message > "/dev/stderr"; bad=1; exit 1 }
function trim(value) { sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); return value }
function identifier(value,    i,c,n,out,nextc) {
  value=trim(value); n=length(value); if (!n) fail("TOC contains a blank table name")
  if (substr(value,1,1)=="\"") {
    out=""; i=2
    while (i<=n) {
      c=substr(value,i,1)
      if (c=="\"") {
        nextc=(i<n ? substr(value,i+1,1) : "")
        if (nextc=="\"") { out=out "\""; i+=2; continue }
        if (trim(substr(value,i+1))!="") fail("quoted identifier has trailing text")
        if (out=="") fail("quoted identifier is empty")
        return out
      }
      out=out c; i++
    }
    fail("unterminated quoted identifier")
  }
  if (value !~ /^[A-Za-z_][A-Za-z0-9_$]*$/) fail("invalid identifier")
  return value
}
{
  line=$0
  if (line !~ /^[[:space:]]*[0-9]+;[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+TABLE[[:space:]]+public[[:space:]]+/) next
  sub(/^[[:space:]]*[0-9]+;[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+TABLE[[:space:]]+public[[:space:]]+/, "", line)
  if (substr(line,1,1)=="\"") {
    # Consume the quoted identifier without splitting on spaces/doubled quotes.
    i=2; closed=0
    while (i<=length(line)) {
      c=substr(line,i,1)
      if (c=="\"") {
        if (i<length(line) && substr(line,i+1,1)=="\"") { i+=2; continue }
        i++; closed=1; break
      }
      i++
    }
    if (!closed) fail("unterminated TOC quoted identifier")
    name=identifier(substr(line,1,i-1))
    if (trim(substr(line,i))=="") fail("TOC table row has no owner")
  } else {
    split(line, fields, /[[:space:]]+/)
    name=identifier(fields[1])
    if (fields[2]=="") fail("TOC table row has no owner")
  }
  if (seen[name]++) fail("TOC contains duplicate table entries")
  count++
  print name
}
END { if (count==0 && !bad) { print "TOC contains no public table entries" > "/dev/stderr"; exit 1 } }
' "$toc" > "$tmpdir/toc.raw"
LC_ALL=C sort "$tmpdir/toc.raw" > "$tmpdir/observed"

cmp -s "$tmpdir/expected" "$tmpdir/observed" || {
  echo 'table set mismatch between manifest and archive TOC' >&2
  diff -u "$tmpdir/expected" "$tmpdir/observed" >&2 || true
  exit 1
}
