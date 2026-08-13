#!/bin/sh
set -eu
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL}"
: "${GUTTER_RUNTIME_ACL_SQL_FILE:=$(dirname "$0")/../packages/db/drizzle/0013_runtime_acl_bootstrap.sql}"
test -f "$GUTTER_RUNTIME_ACL_SQL_FILE" || { echo 'runtime ACL policy file not found' >&2; exit 2; }
psql "$GUTTER_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$GUTTER_RUNTIME_ACL_SQL_FILE"
