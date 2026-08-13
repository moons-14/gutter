#!/bin/sh
set -eu
run_id="${SCALE_RUN_ID:-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}"
root_id="scale-worker-root-${run_id}"
project="gutter-scale-${run_id}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-issue26-postgres-test}"
export SCALE_RUN_ID="$run_id" SCALE_ROOT_ID="$root_id"
exec docker compose -p "$project" --profile scale run --rm scale-oracles
