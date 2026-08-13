#!/bin/sh
set -eu
run_id="${SCALE_RUN_ID:-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}"
root_id="scale-worker-root-${run_id}"
project="gutter-scale-${run_id}"
target="${SCALE_EVIDENCE_PATH:-/tmp/gutter-scale-evidence-${run_id}.json}"
case "$target" in /*.json) ;; *) echo 'SCALE_EVIDENCE_PATH must be a safe absolute .json path' >&2; exit 2 ;; esac
case "$target" in /|/etc/*|/var/*|/usr/*) echo 'SCALE_EVIDENCE_PATH targets a protected path' >&2; exit 2 ;; esac
staging="/tmp/gutter-scale-evidence-${run_id}"
mkdir -p "$staging"
cleanup() {
  docker compose -p "$project" --profile scale down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$staging"
}
trap cleanup EXIT INT TERM
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-issue26-postgres-test}"
export SCALE_RUN_ID="$run_id" SCALE_ROOT_ID="$root_id" SCALE_EVIDENCE_DIR="$staging"
export SCALE_FULL="${SCALE_FULL-}" SCALE_BOOKS="${SCALE_BOOKS-}" SCALE_PAGES_PER_BOOK="${SCALE_PAGES_PER_BOOK-}"
docker compose -p "$project" --profile scale run --rm scale-oracles
mkdir -p "$(dirname "$target")"
cp "$staging/evidence.json" "$target"
printf 'SCALE_ORACLE_EVIDENCE %s\n' "$target"
