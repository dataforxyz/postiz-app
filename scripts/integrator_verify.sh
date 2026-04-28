#!/usr/bin/env bash
# integrator_verify.sh — pnpm verify pipeline for the postiz-app auto-integrator.
#
# Called by auto_integrate_dev_prs.py with the scratch worktree directory as
# the first argument (required). The permanent repo root (where node_modules
# lives) is inferred as the parent of this script's own directory.
#
# Strategy for scratch worktrees in /tmp:
#   The scratch git worktree does not have node_modules. Rather than running
#   a full pnpm install (slow, may hit approve-builds gate), we symlink
#   node_modules from the permanent worktree so installed packages are reused.
#   A minimal `pnpm install --frozen-lockfile --ignore-scripts` is still run
#   to ensure the lockfile hasn't drifted (postinstall/prisma-generate is
#   skipped with --ignore-scripts since the permanent root already ran it).
#
# Steps (in order, fail-fast):
#   1. Symlink node_modules from permanent repo root into scratch worktree.
#   2. pnpm install --frozen-lockfile --ignore-scripts  (sync deps, skip scripts)
#   3. typecheck: skipped (no typecheck script in any workspace package)
#   4. lint: skipped (no root lint script in postiz-app)
#   5. test: skipped (Jest requires a running DB; gate runs in Forgejo CI)
#   6. pnpm build  — full monorepo build (mirrors the Docker Build CI gate)
#
# Exit 0 on full pipeline green; non-zero on first failure.
# Timing for each step is printed to stdout as "step=<name> duration_s=<n>".

set -euo pipefail

SCRATCH_DIR="${1:?Usage: integrator_verify.sh <scratch-worktree-dir>}"
cd "$SCRATCH_DIR"

# The permanent repo root is the parent of the scripts/ directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERMANENT_ROOT="$(dirname "$SCRIPT_DIR")"

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

# ── 1. symlink node_modules from permanent root ───────────────────────────────
echo "[verify] symlinking node_modules from ${PERMANENT_ROOT}"
if [ ! -e "${SCRATCH_DIR}/node_modules" ]; then
  ln -s "${PERMANENT_ROOT}/node_modules" "${SCRATCH_DIR}/node_modules"
fi

# Symlink per-app node_modules if they exist in the permanent root
for app_dir in apps/backend apps/frontend apps/orchestrator apps/extension apps/sdk apps/commands; do
  if [ -d "${PERMANENT_ROOT}/${app_dir}/node_modules" ] && [ ! -e "${SCRATCH_DIR}/${app_dir}/node_modules" ]; then
    ln -s "${PERMANENT_ROOT}/${app_dir}/node_modules" "${SCRATCH_DIR}/${app_dir}/node_modules"
  fi
done

# Symlink library node_modules
for lib_dir in "${PERMANENT_ROOT}"/libraries/*/; do
  lib_name="$(basename "$lib_dir")"
  if [ -d "${lib_dir}/node_modules" ] && [ -d "${SCRATCH_DIR}/libraries/${lib_name}" ] && [ ! -e "${SCRATCH_DIR}/libraries/${lib_name}/node_modules" ]; then
    ln -s "${lib_dir}/node_modules" "${SCRATCH_DIR}/libraries/${lib_name}/node_modules"
  fi
done

# ── 2. pnpm install (sync lockfile, skip scripts to avoid approve-builds gate) ─
run_step "install" pnpm install --frozen-lockfile --ignore-scripts

# ── 3. typecheck ─────────────────────────────────────────────────────────────
# postiz-app workspaces do not define a typecheck script.
echo "[verify] step=typecheck: no typecheck script in any workspace package; skipping"

# ── 4. lint ───────────────────────────────────────────────────────────────────
# postiz-app has no root lint script (linting is per-app via next lint / tsc).
echo "[verify] step=lint: no root lint script; skipping"

# ── 5. test ───────────────────────────────────────────────────────────────────
# pnpm test runs Jest which requires a running database (Prisma). Skipping
# here; the test gate lives in Forgejo CI (runs with a real DB in Docker).
echo "[verify] step=test: skipped (Jest requires DB; gate runs in Forgejo CI)"

# ── 6. build ─────────────────────────────────────────────────────────────────
# This is the primary gate — same as the Docker Build CI workflow.
run_step "build" pnpm build

echo "[verify] all steps passed"
