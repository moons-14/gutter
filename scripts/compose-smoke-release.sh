#!/bin/sh
set -eu

# Use an isolated, random Compose project so this release gate cannot touch a
# developer's default project or accidentally reuse a database volume.
project="gutter-release-smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
case "$project" in
  gutter-release-smoke-[0-9a-f][0-9a-f]*) ;;
  *) echo 'failed to create a valid isolated Compose project name' >&2; exit 2 ;;
esac

cleanup() {
  status=$?
  docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose -p "$project" up --build --abort-on-container-exit --exit-code-from test test
