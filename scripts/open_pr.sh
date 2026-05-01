#!/usr/bin/env bash
# Open a PR against postiz-app via the Forgejo API, forcing an explicit base.
#
# Exists because agents repeatedly POST /pulls without setting "base" and
# Forgejo silently uses the repo default branch (main), which fails against
# branch protection rules that only main enforces. This helper removes the
# ambiguity: --base is required and only two values are allowed.
#
# Usage:
#   scripts/open_pr.sh \
#     --head feat/my-branch \
#     --title "feat: something" \
#     --body "Closes #123" \
#     --base preview
#
#   --base preview   → targets dev/all-open-prs-preview (default for feature PRs)
#   --base main      → targets main (ONLY for release PRs from preview)
#
# Prints the PR html_url on success, exit 1 on any validation or API error.

set -euo pipefail

BASE=""
TITLE=""
BODY=""
HEAD=""
SKIP_VERIFY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --base)  BASE="$2"; shift 2 ;;
        --title) TITLE="$2"; shift 2 ;;
        --body)  BODY="$2"; shift 2 ;;
        --head)  HEAD="$2"; shift 2 ;;
        --skip-verify) SKIP_VERIFY=1; shift ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' | head -n 30
            exit 0
            ;;
        *) echo "open_pr.sh: unknown argument: $1" >&2; exit 1 ;;
    esac
done

for var in BASE TITLE HEAD; do
    if [[ -z "${!var}" ]]; then
        echo "open_pr.sh: missing required --${var,,}" >&2
        exit 1
    fi
done

case "$BASE" in
    preview) BASE_REF="dev/all-open-prs-preview" ;;
    main)    BASE_REF="main" ;;
    *)
        echo "open_pr.sh: --base must be 'preview' or 'main' (got '$BASE')" >&2
        echo "  preview → dev/all-open-prs-preview (feature PRs, auto-integrator)" >&2
        echo "  main    → main (release PRs from preview only)" >&2
        exit 1
        ;;
esac

REPO_DIR="${REPO_DIR:-/home/dev/src/fgit.datafor.xyz/datafor/postiz-app}"
FGIT_TOKEN="${FGIT_TOKEN:-}"
if [[ -z "$FGIT_TOKEN" ]]; then
    FGIT_TOKEN=$(git -C "$REPO_DIR" remote get-url origin \
        | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
fi
if [[ -z "$FGIT_TOKEN" ]]; then
    echo "open_pr.sh: FGIT_TOKEN not set and could not infer from git remote" >&2
    exit 1
fi

# Ensure the branch exists on the remote before the API call — otherwise
# Forgejo returns 404 "could not find <head> to be a commit, branch or
# tag in the head repository". If the branch exists locally, push it.
# Idempotent: already-synced branches produce "Everything up-to-date".
# This runs from whatever cwd open_pr.sh was invoked from; any worktree
# whose HEAD matches HEAD_BRANCH will work.
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$HEAD"; then
    # Branch exists in main checkout — use its worktree.
    push_dir="$REPO_DIR"
else
    # Otherwise look for a linked worktree currently on this branch.
    push_dir=$(git -C "$REPO_DIR" worktree list --porcelain \
        | awk -v b="refs/heads/$HEAD" '
            /^worktree / {path=$2}
            /^branch /   {if ($2==b) {print path; exit}}
          ')
fi
if [[ -n "$push_dir" ]]; then
    # Run `make verify` before pushing / opening the PR. Catches the most common class of agent-produced regression —
    # forgetting to run pnpm lint/typecheck
    # before pushing — which otherwise lands as an integrator
    # [verify-failed] sentinel, burns a cron cycle, and leaves the PR
    # stuck until someone reads the comment and pushes a fix. Running it
    # here fails fast with the exact lint/format output.
    #
    # --skip-verify is an emergency escape (e.g. unsticking a baseline-red
    # preview where `make verify` on the feature branch inherits the
    # preexisting failure).
    if [[ "$SKIP_VERIFY" -eq 0 ]]; then
        echo "open_pr.sh: running 'scripts/integrator_verify.sh' in $push_dir before pushing" >&2
        if ! (cd "$push_dir" && bash scripts/integrator_verify.sh 2>&1 | tail -n 80); then
            echo >&2
            echo "open_pr.sh: 'integrator_verify.sh' FAILED — refusing to open PR." >&2
            echo "open_pr.sh: fix the failure locally and re-run, or pass --skip-verify to bypass." >&2
            exit 1
        fi
        echo "open_pr.sh: verify passed" >&2
    else
        echo "open_pr.sh: --skip-verify set; skipping local gate (not recommended)" >&2
    fi

    if ! git -C "$push_dir" push -u origin "$HEAD:$HEAD" 2>&1 | sed 's/^/  /'; then
        echo "open_pr.sh: git push failed; aborting PR open" >&2
        exit 1
    fi
else
    echo "open_pr.sh: branch '$HEAD' not found locally; assuming already pushed (verify skipped)" >&2
fi

payload=$(python3 -c '
import json, sys
print(json.dumps({
    "title": sys.argv[1],
    "body":  sys.argv[2],
    "head":  sys.argv[3],
    "base":  sys.argv[4],
}))' "$TITLE" "$BODY" "$HEAD" "$BASE_REF")

response=$(curl -sS -X POST \
    -H "Authorization: token $FGIT_TOKEN" \
    -H "Content-Type: application/json" \
    "https://fgit.datafor.xyz/api/v1/repos/datafor/postiz-app/pulls" \
    -d "$payload")

url=$(printf '%s' "$response" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
if "html_url" in d:
    print(d["html_url"])
else:
    sys.stderr.write("open_pr.sh: Forgejo error: " + json.dumps(d) + "\n")
    sys.exit(1)
')

if [[ -z "$url" ]]; then
    exit 1
fi
echo "$url"
