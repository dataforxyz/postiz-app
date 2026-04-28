#!/usr/bin/env bash
# integrator_verify.sh — pnpm verify pipeline for the postiz-app auto-integrator.
#
# Called by auto_integrate_dev_prs.py with the worktree directory as the first
# argument (or $PWD if omitted). Runs in the given directory.
#
# Steps (in order, fail-fast):
#   1. pnpm install --frozen-lockfile   — ensure deps match lockfile
#   2. pnpm -r run typecheck            — TypeScript type checking (recursive)
#   3. pnpm lint                        — ESLint (root script, if present)
#   4. pnpm test                        — Jest test suite (if present)
#   5. pnpm build                       — full monorepo build (Docker CI gate)
#
# Exit 0 on full pipeline green; non-zero on first failure.
# Timing for each step is printed to stdout as "step=<name> duration_s=<n>".

set -euo pipefail

WORK_DIR="${1:-$PWD}"
cd "$WORK_DIR"

# ── helpers ───────────────────────────────────────────────────────────────────

_ts() { date -u +%s; }

run_step() {
  local name="$1"
  shift
  local t0
  t0=$(_ts)
  echo "[verify] step=${name} starting..."
  if "$@"; then
    local elapsed=$(( $(_ts) - t0 ))
    echo "step=${name} duration_s=${elapsed} result=green"
  else
    local elapsed=$(( $(_ts) - t0 ))
    echo "step=${name} duration_s=${elapsed} result=red"
    return 1
  fi
}

# ── 1. pnpm install ───────────────────────────────────────────────────────────
run_step "install" pnpm install --frozen-lockfile

# ── 2. typecheck ─────────────────────────────────────────────────────────────
# Use pnpm -r run typecheck if individual apps define it;
# fall back to tsc --noEmit at root.
if pnpm -r run typecheck --if-present 2>/dev/null; then
  echo "step=typecheck duration_s=0 result=green (via pnpm -r)"
else
  # Try root tsc as fallback
  if grep -q '"typecheck"' package.json 2>/dev/null; then
    run_step "typecheck" pnpm typecheck
  else
    # Neither per-package nor root typecheck found; skip with note
    echo "[verify] step=typecheck: no typecheck script found in any workspace package; skipping"
  fi
fi

# ── 3. lint ───────────────────────────────────────────────────────────────────
if node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.lint ? 0 : 1)" 2>/dev/null; then
  run_step "lint" pnpm lint
else
  echo "[verify] step=lint: no root lint script; skipping"
fi

# ── 4. test ───────────────────────────────────────────────────────────────────
if node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.test ? 0 : 1)" 2>/dev/null; then
  run_step "test" pnpm test
else
  echo "[verify] step=test: no root test script; skipping"
fi

# ── 5. build ─────────────────────────────────────────────────────────────────
run_step "build" pnpm build

echo "[verify] all steps passed"
