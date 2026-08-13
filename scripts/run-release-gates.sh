#!/bin/sh
set -eu

# Execute release gates and retain their stdout/stderr as evidence inputs. This script does not
# manufacture release-evidence.json; the release manager must add exact-tree hashes and review
# the logs before invoking verify-release-gate.mjs final.
out=${RELEASE_ARTIFACT_DIR:?set RELEASE_ARTIFACT_DIR to a disposable evidence directory}
mkdir -p "$out"
run_gate() {
  id=$1
  shift
  log="$out/$id.log"
  echo "== $id =="
  "$@" >"$log" 2>&1
  sha256sum "$log" >"$log.sha256"
}

run_gate dependencies corepack pnpm install --frozen-lockfile
run_gate licenses corepack pnpm audit:licenses
run_gate secrets gitleaks detect --source . --redact
run_gate release-contract node scripts/verify-release-gate.mjs contract
run_gate format corepack pnpm check
run_gate openapi corepack pnpm check:openapi-compat
run_gate unit corepack pnpm unit
run_gate lint corepack pnpm lint
run_gate typecheck corepack pnpm typecheck
run_gate build corepack pnpm build
run_gate browser-e2e corepack pnpm --filter @gutter/web test:e2e
run_gate migrations ./scripts/migration-compatibility-oracle.sh
run_gate compose-config docker compose config
run_gate compose-smoke docker compose up --abort-on-container-exit --exit-code-from test test
run_gate backup-restore ./scripts/compose-restore-drill.sh
: "${RELEASE_IMAGE_REFS:?set RELEASE_IMAGE_REFS to the digest-pinned images built for this tree}"
run_gate containers sh -ec 'for image in $RELEASE_IMAGE_REFS; do trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$image"; done'
run_gate sbom sh -ec 'for image in $RELEASE_IMAGE_REFS; do name=$(printf "%s" "$image" | tr "/:@" "___"); syft "$image" -o cyclonedx-json >"$RELEASE_ARTIFACT_DIR/$name.sbom.json"; sha256sum "$RELEASE_ARTIFACT_DIR/$name.sbom.json" >"$RELEASE_ARTIFACT_DIR/$name.sbom.json.sha256"; done'
run_gate provenance sh -ec 'for image in $RELEASE_IMAGE_REFS; do cosign verify-attestation --type slsaprovenance "$image"; done'
if [ -f docs/scale-oracle-evidence.schema.json ]; then
  run_gate scale-concurrency sh -ec 'GUTTER_SCALE_ORACLE=1 SCALE_FULL=1 corepack pnpm --filter @gutter/db exec tsx ../../tests/integration/scale-oracles.mts'
else
  echo '#26 scale oracle is not present; final release remains blocked' >"$out/scale-concurrency.blocked"
  sha256sum "$out/scale-concurrency.blocked" >"$out/scale-concurrency.blocked.sha256"
fi

echo "release gate command logs written to $out"
