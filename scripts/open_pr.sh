#!/usr/bin/env bash
# Forwarding shim.
# Canonical: juston-infra/juston-deploy-local/scripts/open_pr.sh
# Edit the canonical file, not this one. This shim's only job is to find and
# exec the canonical with the args verbatim. The target repo is auto-detected
# from the cwd's origin by the canonical script.
#
# Resolution must work both from the shared checkout AND from a git worktree
# relocated outside the canonical tree (e.g. ~/worktrees/<repo>-<feature>),
# so we try several strategies rather than a single fixed relative path.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="juston-infra/juston-deploy-local/scripts/open_pr.sh"

candidates=("$HERE/../../../$REL")

# Resolve relative to the repo's MAIN working tree. --git-common-dir points at
# the main repo's .git even from a linked worktree, so this fixes the case
# where the shim file physically lives under ~/worktrees/ (where the fixed
# ../../../ path above lands outside the canonical tree and misses).
common_dir="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$common_dir" ]]; then
    main_root="$(cd "$common_dir/.." && pwd)"
    candidates+=("$main_root/../../$REL")
fi

# Absolute fallback: canonical workspace layout.
candidates+=("$HOME/src/fgit.datafor.xyz/$REL")

CANONICAL=""
for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
        CANONICAL="$(cd "$(dirname "$c")" && pwd)/open_pr.sh"
        break
    fi
done

if [[ -z "$CANONICAL" ]]; then
    echo "open_pr.sh shim: canonical not found; tried:" >&2
    printf '  %s\n' "${candidates[@]}" >&2
    echo "open_pr.sh shim: clone juston-infra/juston-deploy-local under ~/src/fgit.datafor.xyz/" >&2
    exit 1
fi
exec "$CANONICAL" "$@"
