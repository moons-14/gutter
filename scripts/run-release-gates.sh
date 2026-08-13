#!/bin/sh
set -eu

# Execute release gates and retain their stdout/stderr as evidence inputs. This script does not
# manufacture release-evidence.json; the release manager must add exact-tree hashes and review
# the logs before invoking verify-release-gate.mjs final.
out=${RELEASE_ARTIFACT_DIR:?set RELEASE_ARTIFACT_DIR to a disposable evidence directory}
case "$out" in /*) out_abs="$out" ;; *) out_abs="$(pwd)/$out" ;; esac
mkdir -p "$out_abs"
out=$(cd "$out_abs" && pwd)
export RELEASE_ARTIFACT_DIR="$out"
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
generated_postgres_password=0
cleanup_generated_secrets() {
  if [ -n "$generated_secrets" ]; then
    rm -f $generated_secrets
  fi
  if [ "$generated_postgres_password" -eq 1 ]; then unset POSTGRES_PASSWORD; fi
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
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  export POSTGRES_PASSWORD
  generated_postgres_password=1
fi
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
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$command_text" "$(printf '%s' "$command_text" | sha256sum | cut -d' ' -f1)" "$status" "release-artifacts/$id.log" "$(sha256sum "$log" | cut -d' ' -f1)" >>"$results"
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
docker compose build api worker web
application_image_refs=''
api_subject=''; worker_subject=''; web_subject=''
if [ -n "${RELEASE_IMAGE_REGISTRY:-}" ]; then
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required when publishing application subjects}"
  printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:?GITHUB_ACTOR is required}" --password-stdin
fi
for service in api worker web; do
  image_ref="gutter-release-$service:local"
  image_id=$(docker image inspect --format '{{.Id}}' "$image_ref")
  case "$image_id" in sha256:[0-9a-f][0-9a-f]*) ;; *) echo "missing immutable image ID for $service" >&2; exit 1 ;; esac
  if [ -n "${RELEASE_IMAGE_REGISTRY:-}" ]; then
    published="$RELEASE_IMAGE_REGISTRY/$service:${GITHUB_SHA:?GITHUB_SHA is required}"
    docker tag "$image_id" "$published"
    docker push "$published" >/dev/null
    digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$published")
    case "$digest" in *@sha256:[0-9a-f][0-9a-f]*) subject="$digest" ;; *) echo "missing registry digest for $service" >&2; exit 1 ;; esac
  else
    subject="local/gutter-release-$service@$image_id"
  fi
  application_image_refs="$application_image_refs $subject"
  case "$service" in
    api) api_subject="$subject" ;;
    worker) worker_subject="$subject" ;;
    web) web_subject="$subject" ;;
  esac
done
export RELEASE_IMAGE_REFS="$application_image_refs"
mapping="$out/application-subjects.json"
printf '[{"service":"api","localTag":"gutter-release-api:local","subject":"%s"},{"service":"worker","localTag":"gutter-release-worker:local","subject":"%s"},{"service":"web","localTag":"gutter-release-web:local","subject":"%s"}]\n' "$api_subject" "$worker_subject" "$web_subject" >"$mapping"
export RELEASE_APPLICATION_SUBJECTS="$mapping"
printf 'api\tgutter-release-api:local\t%s\nworker\tgutter-release-worker:local\t%s\nweb\tgutter-release-web:local\t%s\n' "$api_subject" "$worker_subject" "$web_subject" >"$out/application-subjects.tsv"
run_gate containers 'trivy built application image subjects' sh -ec 'while IFS="	" read -r service local_tag subject; do scan_ref="$subject"; case "$subject" in local/*@sha256:*) scan_ref="$local_tag" ;; esac; docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$RELEASE_TRIVY_IMAGE" image --db-repository "$RELEASE_TRIVY_DB_REPOSITORY" --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$scan_ref"; done <"$RELEASE_ARTIFACT_DIR/application-subjects.tsv"'
run_gate sbom 'syft canonical application subjects cyclonedx' sh -ec 'while IFS="	" read -r service local_tag subject; do scan_ref="$subject"; case "$subject" in local/*@sha256:*) scan_ref="$local_tag" ;; esac; docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$RELEASE_SYFT_IMAGE" "$scan_ref" -o cyclonedx-json >"$RELEASE_ARTIFACT_DIR/$service.sbom.json"; sha256sum "$RELEASE_ARTIFACT_DIR/$service.sbom.json" >"$RELEASE_ARTIFACT_DIR/$service.sbom.json.sha256"; done <"$RELEASE_ARTIFACT_DIR/application-subjects.tsv"'
run_gate provenance 'cosign built application image attestations' sh -ec 'while IFS="	" read -r service local_tag subject; do docker run --rm "$RELEASE_COSIGN_IMAGE" verify-attestation --type slsaprovenance --certificate-identity-regexp "$RELEASE_COSIGN_CERTIFICATE_IDENTITY_REGEXP" --certificate-oidc-issuer "$RELEASE_COSIGN_OIDC_ISSUER" "$subject" --output json >"$RELEASE_ARTIFACT_DIR/$service.provenance.json"; done <"$RELEASE_ARTIFACT_DIR/application-subjects.tsv"'
if [ -f docs/scale-oracle-evidence.schema.json ]; then
  run_gate scale-concurrency 'SCALE_FULL=1 production Compose scale oracle' env SCALE_FULL=1 SCALE_EVIDENCE_PATH="$RELEASE_ARTIFACT_DIR/scale-evidence.json" ./scripts/run-scale-oracle.sh
else
  echo '#26 scale oracle is not present; final release remains blocked' >"$out/scale-concurrency.blocked"
  cp "$out/scale-concurrency.blocked" "$out/scale-concurrency.log"
  sha256sum "$out/scale-concurrency.blocked" >"$out/scale-concurrency.blocked.sha256"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' 'scale-concurrency' 'SCALE_FULL=1 production Compose scale oracle' "$(printf '%s' 'SCALE_FULL=1 production Compose scale oracle' | sha256sum | cut -d' ' -f1)" 99 'release-artifacts/scale-concurrency.log' "$(sha256sum "$out/scale-concurrency.blocked" | cut -d' ' -f1)" >>"$results"
fi
node scripts/generate-release-evidence.mjs "${results#./}" release-evidence.json
echo "release gate command logs and release-evidence.json written to $out"
[ "$failed" -eq 0 ]
