#!/bin/sh
set -eu
run_id="${SCALE_RUN_ID:-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}"
root_id="scale-worker-root-${run_id}"
project="gutter-scale-${run_id}"
target="${SCALE_EVIDENCE_PATH:-/tmp/gutter-scale-evidence-${run_id}.json}"
case "$target" in /*/evidence.json) ;; *) echo 'SCALE_EVIDENCE_PATH must be absolute and end in evidence.json' >&2; exit 2 ;; esac
staging="/tmp/gutter-scale-evidence-${run_id}"
mkdir -p "$staging"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-issue26-postgres-test}"
export SCALE_RUN_ID="$run_id" SCALE_ROOT_ID="$root_id" SCALE_EVIDENCE_DIR="$staging"
docker compose -p "$project" --profile scale run --rm scale-oracles
mkdir -p "$(dirname "$target")"
cp "$staging/evidence.json" "$target"
rm -rf "$staging"
printf 'SCALE_ORACLE_EVIDENCE %s\n' "$target"
