#!/usr/bin/env bash
# integrator_verify.sh — pnpm verify pipeline for the postiz-app auto-integrator.
#
# Called by auto_integrate_dev_prs.py with the scratch worktree directory as
# the first argument (required).
#
# Steps (in order, fail-fast):
#   1. pnpm install --frozen-lockfile --ignore-scripts  (19s; uses shared store;
#      bypasses approve-builds gate by skipping lifecycle scripts)
#   2. pnpm run prisma-generate  (3s; Prisma client must be generated for tsc)
#   3. typecheck: skipped (no typecheck script in any workspace package)
#   4. lint: skipped (no root lint script in postiz-app)
#   5. test: skipped (Jest requires a running DB; gate runs in Forgejo CI)
#   6. pnpm build  (~3 min; full monorepo build, same as Docker Build CI gate)
#
# Exit 0 on full pipeline green; non-zero on first failure.
# Timing for each step is printed to stdout as "step=<name> duration_s=<n>".

set -euo pipefail

SCRATCH_DIR="${1:?Usage: integrator_verify.sh <scratch-worktree-dir>}"
cd "$SCRATCH_DIR"

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
    local rc=$?
    local elapsed=$(( $(_ts) - t0 ))
    echo "step=${name} duration_s=${elapsed} result=red (exit ${rc})"
    return $rc
  fi
}

# ── 1. pnpm install ───────────────────────────────────────────────────────────
# Use --ignore-scripts to bypass the approve-builds interactive gate (esbuild,
# prisma, sharp, etc.) which requires terminal interaction.  All packages come
# from the shared pnpm store — no downloads needed (~20 s).
# postinstall (prisma-generate) is handled separately in step 2.
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$(pnpm store path 2>/dev/null || echo /home/dev/.local/share/pnpm/store/v10)}"
run_step "install" pnpm install \
  --frozen-lockfile \
  --ignore-scripts \
  --store-dir "${PNPM_STORE_DIR}"

# ── 2. prisma-generate ───────────────────────────────────────────────────────
# The postinstall script that --ignore-scripts skipped above. Prisma must
# generate its TypeScript client for type-checking and compilation to work.
run_step "prisma-generate" pnpm run prisma-generate

# ── 3. typecheck ─────────────────────────────────────────────────────────────
# postiz-app workspaces do not define a standalone typecheck script; tsc is
# invoked implicitly by nest build / next build in the build step.
echo "[verify] step=typecheck: no standalone typecheck script; covered by build step"

# ── 4. lint ───────────────────────────────────────────────────────────────────
# postiz-app has no root lint script.
echo "[verify] step=lint: no root lint script; skipping"

# ── 5. test ───────────────────────────────────────────────────────────────────
# pnpm test runs Jest which requires a running database (Prisma). Skipping;
# the test gate lives in Forgejo CI (runs with a real DB in Docker).
echo "[verify] step=test: skipped (Jest requires DB; gate runs in Forgejo CI)"

# ── 6. build ─────────────────────────────────────────────────────────────────
# Full monorepo build — mirrors the Docker Build CI gate (frontend + backend +
# orchestrator). NestJS compilation catches TypeScript errors not covered by
# other steps.
run_step "build" pnpm build

echo "[verify] all steps passed"
