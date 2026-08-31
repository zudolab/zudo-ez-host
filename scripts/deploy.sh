#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <staging|production>" >&2
  exit 2
fi

ENVIRONMENT="$1"
case "$ENVIRONMENT" in
  staging|production) ;;
  *)
    echo "Unsupported environment: $ENVIRONMENT (expected staging or production)" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${EZ_HOST_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"

if ! bash "$REPO_ROOT/scripts/preflight-env.sh" "$ENVIRONMENT"; then
  echo "Deployment stopped: configuration preflight failed; no Worker deploy was started." >&2
  exit 1
fi

run_wrangler() {
  local worker="$1"
  shift
  local worker_dir="$REPO_ROOT/workers/$worker"

  if [[ -n "${EZ_HOST_WRANGLER_BIN:-}" ]]; then
    (cd -- "$worker_dir" && "$EZ_HOST_WRANGLER_BIN" "$@")
  else
    (cd -- "$worker_dir" && pnpm exec wrangler "$@")
  fi
}

echo "Deploying control Worker to $ENVIRONMENT..."
run_wrangler control deploy --config wrangler.toml --env "$ENVIRONMENT"

echo "Deploying public Worker to $ENVIRONMENT..."
run_wrangler public deploy --config wrangler.toml --env "$ENVIRONMENT"

echo "Deployment complete for $ENVIRONMENT (control before public)."
