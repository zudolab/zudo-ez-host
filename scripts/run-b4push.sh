#!/usr/bin/env bash
set -uo pipefail

# Pre-push check suite for zudo-ez-host. All seven steps mirror
# .github/workflows/ci.yml so failures surface locally instead of on the
# runner, including the documentation parity and link checks.
#
# Failures are collected rather than exited on, so one run reports every broken
# step instead of costing a round-trip per fix.

START_TIME=$(date +%s)
FAILURES=()

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

step() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

run_step() {
  local label="$1"
  shift
  step "$label"
  if (cd "$ROOT_DIR" && "$@"); then
    echo "✅ $label"
  else
    echo "❌ $label"
    FAILURES+=("$label")
  fi
}

run_step "Step 1/7: Install dependencies (frozen lockfile)" pnpm install --frozen-lockfile
run_step "Step 2/7: Format check"                           pnpm format:check
run_step "Step 3/7: Lint"                                   pnpm lint
run_step "Step 4/7: Typecheck"                              pnpm typecheck
run_step "Step 5/7: Build"                                  pnpm build
run_step "Step 6/7: Documentation i18n parity"              pnpm check:doc:i18n
run_step "Step 7/7: Documentation internal links"           pnpm check:doc:links

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUMMARY (${DURATION}s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "✅ All checks passed! Safe to push."
  exit 0
fi

echo "❌ ${#FAILURES[@]} check(s) failed:"
for f in "${FAILURES[@]}"; do
  echo "   - $f"
done
exit 1
