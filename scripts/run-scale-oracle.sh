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
if [ "${SCALE_DOCKER_PROBE:-}" = mock-fail ]; then
  echo 'Docker preflight failed unexpectedly' >&2
  exit 1
fi
if [ "${SCALE_DOCKER_PROBE:-}" = mock-unavailable ] || [ "${SCALE_DOCKER_PREFLIGHT:-1}" = 1 ]; then
  if [ "${SCALE_DOCKER_PROBE:-}" = mock-unavailable ] || ! docker info >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    mkdir -p "$(dirname "$target")"
    cat >"$target" <<EOF
{"schemaVersion":"gutter.scale-oracle.v1","status":"unavailable","unavailablePlatformReason":"docker:DockerUnavailable","seed":"${SCALE_SEED:-gutter-issue-26-v1}","runId":"${run_id}","dataset":{"books":1000,"pages":10000,"sourceFixtureBooks":1000,"sourceFixturePages":1000},"thresholds":{"sourceFixtureBooks":1000,"sourceFixturePages":1000,"readerCount":5,"coldProducerCount":1,"sparseAllocatedBlocksMax":1024,"advisoryCatalogP95Ms":1000,"advisorySearchP95Ms":1000,"advisoryScanP95Ms":30000},"environment":{"node":"unknown","postgres":{},"setupDatabaseRole":"gutter","workerDatabaseRole":"gutter_worker","sourceMount":"read-only"},"timingsMs":{},"plans":{"queryShape":"unavailable","list":[],"search":[]},"cache":{"readers":5,"coldProducers":1,"warmHit":false,"gc":false,"pressure":{"quotaBytes":0,"reclaimedBytes":0,"protectedLiveEntry":true}},"worker":{"queueCompletedRuns":0,"runs":{}},"sparse":{"logicalBytes":21990232555520,"allocatedBlocks":0},"baselineComparison":{"baseline":"docs/scale-oracle-baseline.json","baselineSha256":"0000000000000000000000000000000000000000000000000000000000000000","portable":"fail","hardwareAdvisory":{}}}
EOF
    printf 'SCALE_ORACLE_EVIDENCE %s\n' "$target"
    exit 0
  fi
fi
cleanup() {
  docker compose -p "$project" --profile scale down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$staging"
}
trap cleanup EXIT INT TERM
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-issue26-postgres-test}"
export SCALE_RUN_ID="$run_id" SCALE_ROOT_ID="$root_id" SCALE_EVIDENCE_DIR="$staging"
docker compose -p "$project" --profile scale run --rm scale-oracles
mkdir -p "$(dirname "$target")"
cp "$staging/evidence.json" "$target"
printf 'SCALE_ORACLE_EVIDENCE %s\n' "$target"
