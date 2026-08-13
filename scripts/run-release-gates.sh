#!/bin/sh
set -eu

# Execute release gates and retain their stdout/stderr as evidence inputs. This script does not
# manufacture release-evidence.json; the release manager must add exact-tree hashes and review
# the logs before invoking verify-release-gate.mjs final.
out=${RELEASE_ARTIFACT_DIR:?set RELEASE_ARTIFACT_DIR to a disposable evidence directory}
mkdir -p "$out"
gitleaks_image=${RELEASE_GITLEAKS_IMAGE:?set RELEASE_GITLEAKS_IMAGE to the digest-pinned tool ref}
trivy_image=${RELEASE_TRIVY_IMAGE:?set RELEASE_TRIVY_IMAGE to the digest-pinned tool ref}
trivy_db_repository=${RELEASE_TRIVY_DB_REPOSITORY:?set RELEASE_TRIVY_DB_REPOSITORY to the immutable digest-pinned Trivy DB ref}
case "$trivy_db_repository" in
  ghcr.io/aquasecurity/trivy-db:2@sha256:[0-9a-f][0-9a-f]*) ;;
  *) echo 'RELEASE_TRIVY_DB_REPOSITORY must be the pinned official trivy-db:2 digest' >&2; exit 2 ;;
esac
syft_image=${RELEASE_SYFT_IMAGE:?set RELEASE_SYFT_IMAGE to the digest-pinned tool ref}
cosign_image=${RELEASE_COSIGN_IMAGE:?set RELEASE_COSIGN_IMAGE to the digest-pinned tool ref}
cosign_identity=${RELEASE_COSIGN_CERTIFICATE_IDENTITY_REGEXP:?set RELEASE_COSIGN_CERTIFICATE_IDENTITY_REGEXP to the GitHub OIDC identity regexp}
cosign_issuer=${RELEASE_COSIGN_OIDC_ISSUER:?set RELEASE_COSIGN_OIDC_ISSUER to the GitHub OIDC issuer}
results="$out/runner-results.tsv"
: >"$results"
failed=0
generated_secrets=''
cleanup_generated_secrets() {
  if [ -n "$generated_secrets" ]; then
    rm -f $generated_secrets
  fi
}
trap cleanup_generated_secrets EXIT INT TERM
umask 077
mkdir -p secrets
for secret in api_db_password worker_db_password better_auth_secret reader_capability_secret; do
  path="secrets/$secret"
  if [ ! -s "$path" ]; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$path"
    generated_secrets="$generated_secrets $path"
  fi
done
run_gate() {
  id=$1
  shift
  canonical=$1
  shift
  log="$out/$id.log"
  echo "== $id =="
  command_text="$canonical"
  if "$@" >"$log" 2>&1; then status=0; else status=$?; failed=1; fi
  sha256sum "$log" >"$log.sha256"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$command_text" "$(printf '%s' "$command_text" | sha256sum | cut -d' ' -f1)" "$status" "$log" "$(sha256sum "$log" | cut -d' ' -f1)" >>"$results"
  return 0
}

run_gate dependencies 'corepack pnpm install --frozen-lockfile' corepack pnpm install --frozen-lockfile
run_gate licenses 'corepack pnpm audit:licenses' corepack pnpm audit:licenses
run_gate secrets 'gitleaks detect --source . --redact' docker run --rm -v "$PWD:/repo:ro" -w /repo "$gitleaks_image" detect --source . --redact
run_gate release-contract 'node scripts/verify-release-gate.mjs contract' node scripts/verify-release-gate.mjs contract
run_gate format 'corepack pnpm check' corepack pnpm check
run_gate openapi 'corepack pnpm check:openapi-compat' corepack pnpm check:openapi-compat
run_gate unit 'corepack pnpm unit' corepack pnpm unit
run_gate lint 'corepack pnpm lint' corepack pnpm lint
run_gate typecheck 'corepack pnpm typecheck' corepack pnpm typecheck
run_gate build 'corepack pnpm build' corepack pnpm build
run_gate browser-e2e 'corepack pnpm --filter @gutter/web test:e2e' corepack pnpm --filter @gutter/web test:e2e
run_gate migrations './scripts/migration-compatibility-oracle.sh' ./scripts/migration-compatibility-oracle.sh
run_gate compose-config 'docker compose config' docker compose config
run_gate compose-smoke 'docker compose up --abort-on-container-exit --exit-code-from test test' docker compose up --abort-on-container-exit --exit-code-from test test
run_gate operations 'node scripts/verify-operations.mjs' node scripts/verify-operations.mjs
run_gate backup-restore './scripts/compose-restore-drill.sh' ./scripts/compose-restore-drill.sh
run_gate nas-source './scripts/nas-source-oracle.sh' ./scripts/nas-source-oracle.sh
: "${RELEASE_IMAGE_REFS:?set RELEASE_IMAGE_REFS to the digest-pinned images built for this tree}"
run_gate containers 'trivy image pinned release refs' sh -ec 'for image in $RELEASE_IMAGE_REFS; do docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$RELEASE_TRIVY_IMAGE" image --db-repository "$RELEASE_TRIVY_DB_REPOSITORY" --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$image"; done'
run_gate sbom 'syft pinned release refs cyclonedx' sh -ec 'for image in $RELEASE_IMAGE_REFS; do name=$(printf "%s" "$image" | tr "/:@" "___"); docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$RELEASE_SYFT_IMAGE" "$image" -o cyclonedx-json >"$RELEASE_ARTIFACT_DIR/$name.sbom.json"; sha256sum "$RELEASE_ARTIFACT_DIR/$name.sbom.json" >"$RELEASE_ARTIFACT_DIR/$name.sbom.json.sha256"; done'
run_gate provenance 'cosign pinned release refs slsaprovenance' sh -ec 'for image in $RELEASE_IMAGE_REFS; do docker run --rm "$RELEASE_COSIGN_IMAGE" verify-attestation --type slsaprovenance --certificate-identity-regexp "$RELEASE_COSIGN_CERTIFICATE_IDENTITY_REGEXP" --certificate-oidc-issuer "$RELEASE_COSIGN_OIDC_ISSUER" "$image"; done'
if [ -f docs/scale-oracle-evidence.schema.json ]; then
  run_gate scale-concurrency 'SCALE_FULL=1 production Compose scale oracle' env SCALE_FULL=1 SCALE_EVIDENCE_PATH="$RELEASE_ARTIFACT_DIR/scale-evidence.json" ./scripts/run-scale-oracle.sh
else
  echo '#26 scale oracle is not present; final release remains blocked' >"$out/scale-concurrency.blocked"
  sha256sum "$out/scale-concurrency.blocked" >"$out/scale-concurrency.blocked.sha256"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' 'scale-concurrency' 'GUTTER_SCALE_ORACLE=1 SCALE_FULL=1 scale oracle' "$(printf '%s' 'GUTTER_SCALE_ORACLE=1 SCALE_FULL=1 scale oracle' | sha256sum | cut -d' ' -f1)" 99 "$out/scale-concurrency.blocked" "$(sha256sum "$out/scale-concurrency.blocked" | cut -d' ' -f1)" >>"$results"
fi
node scripts/generate-release-evidence.mjs "${results#./}" release-evidence.json
echo "release gate command logs and release-evidence.json written to $out"
[ "$failed" -eq 0 ]
