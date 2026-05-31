#!/usr/bin/env bash
# Forwarding shim.
# Canonical: juston-infra/juston-deploy-local/scripts/open_pr.sh
# Edit the canonical file, not this one. This shim's only job is to exec it
# with the args verbatim. Target repo is auto-detected from the cwd's origin.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$HERE/../../../juston-infra/juston-deploy-local/scripts/open_pr.sh"
if [[ ! -x "$CANONICAL" ]]; then
    echo "open_pr.sh shim: canonical not found at $CANONICAL" >&2
    echo "open_pr.sh shim: clone juston-infra/juston-deploy-local as a sibling of this repo's parent dir" >&2
    exit 1
fi
exec "$CANONICAL" "$@"
