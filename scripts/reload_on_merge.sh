#!/usr/bin/env bash
# Watch for a reload-pending flag set by the auto-integrator after a
# successful merge, rebuild postiz (pnpm install + pnpm build), restart the
# running service, run a post-merge smoke test, and:
#   - On smoke pass: removes the flag, exits 0.
#   - On smoke fail: reverts the merge commit on preview, pushes, files a
#     Forgejo issue, re-queues the reload flag (empty, no SHA) so the next
#     cron cycle restarts onto the reverted (known-good) code, exits 0.
#
# Invoked by cron every minute (flock-guarded). See the cron line in the
# project README or the install-reload-on-merge-cron Makefile target.

set -euo pipefail

FLAG="/tmp/postiz-app-integrator-reload-pending"
REPO_DIR="${REPO_DIR:-/home/dev/src/fgit.datafor.xyz/datafor/postiz-app}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
PREVIEW_BRANCH="dev/all-open-prs-preview"
POSTIZ_LOG="${POSTIZ_LOG:-/home/dev/src/fgit.datafor.xyz/datafor/juston-app/runtime/logs/postiz.log}"
JUSTON_DIR="/home/dev/src/fgit.datafor.xyz/datafor/juston-app"

SMOKE_PATHS=(/ /public/v1/internal/integrations)

if [[ ! -f "$FLAG" ]]; then
    exit 0
fi

cd "$REPO_DIR"

# ── Extract merge SHA from flag (may be empty for backward compat) ─────────────
MERGE_SHA=""
MERGE_SHA=$(cat "$FLAG" 2>/dev/null | tr -d '[:space:]') || true

echo "[reload-on-merge] $(date -u -Iseconds) restart triggered by $FLAG (merge_sha=${MERGE_SHA:-<empty>})"

# ── Token for Forgejo API ──────────────────────────────────────────────────────
FGIT_TOKEN=""
FGIT_TOKEN=$(git -C "$REPO_DIR" remote get-url origin \
    | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p') || true
FGIT_HOST="fgit.datafor.xyz"
FGIT_REPO="datafor/postiz-app"

# ── Build step (pnpm install + pnpm build) then restart ───────────────────────
# We must rebuild before restarting because the running postiz process executes
# from apps/backend/dist/apps/backend/src/main — stale JS after a merge.
#
# Close fds 3-9 when invoking make so the long-lived postiz supervisor daemon
# does NOT inherit the flock FD from the cron line's
# `flock -n /tmp/postiz-app-reload-on-merge.lock ...`. Without this the
# process holds the lock alive, future cron invocations fail to acquire
# (flock -n exits 1), and the reload loop silently stops for as long as
# postiz is up.
echo "[reload-on-merge] $(date -u -Iseconds) running pnpm install --frozen-lockfile"
if ! pnpm install --frozen-lockfile 3<&- 4<&- 5<&- 6<&- 7<&- 8<&- 9<&-; then
    echo "[reload-on-merge] $(date -u -Iseconds) pnpm install FAILED; leaving flag for retry" >&2
    exit 1
fi

echo "[reload-on-merge] $(date -u -Iseconds) running pnpm build"
if ! pnpm build 3<&- 4<&- 5<&- 6<&- 7<&- 8<&- 9<&-; then
    echo "[reload-on-merge] $(date -u -Iseconds) pnpm build FAILED; leaving flag for retry" >&2
    exit 1
fi

echo "[reload-on-merge] $(date -u -Iseconds) build complete; restarting postiz via make -C $JUSTON_DIR postiz-restart"
if ! make -C "$JUSTON_DIR" postiz-restart 3<&- 4<&- 5<&- 6<&- 7<&- 8<&- 9<&-; then
    echo "[reload-on-merge] $(date -u -Iseconds) postiz-restart FAILED; leaving flag for retry" >&2
    exit 1
fi

echo "[reload-on-merge] $(date -u -Iseconds) restart complete; running post-merge smoke"

# ── Wait for postiz to settle ─────────────────────────────────────────────────
sleep 5

# ── Post-merge smoke test ──────────────────────────────────────────────────────
FAILED_PATHS=()
declare -A FAILED_STATUS
declare -A FAILED_BODY

for path in "${SMOKE_PATHS[@]}"; do
    response=$(curl -s -o /tmp/postiz-smoke-body -w "%{http_code}" \
        --max-time 10 --connect-timeout 5 \
        "${BASE_URL}${path}" 2>/dev/null) || response="000"
    body=$(head -c 500 /tmp/postiz-smoke-body 2>/dev/null || true)

    if [[ "$response" =~ ^5 ]]; then
        echo "[post-merge-smoke] FAIL ${path} → HTTP ${response}"
        FAILED_PATHS+=("$path")
        FAILED_STATUS["$path"]="$response"
        FAILED_BODY["$path"]="$body"
    else
        echo "[post-merge-smoke] ok   ${path} → HTTP ${response}"
    fi
done

rm -f /tmp/postiz-smoke-body

# ── All pages healthy ──────────────────────────────────────────────────────────
if [[ ${#FAILED_PATHS[@]} -eq 0 ]]; then
    echo "[post-merge-smoke] all pages OK"
    rm -f "$FLAG"
    echo "[reload-on-merge] $(date -u -Iseconds) flag cleared"
    exit 0
fi

# ── Smoke failed ───────────────────────────────────────────────────────────────
echo "[post-merge-smoke] FAILED on: ${FAILED_PATHS[*]}" >&2

# No merge SHA — cannot auto-revert; clear flag and bail.
if [[ -z "$MERGE_SHA" ]]; then
    echo "[post-merge-smoke] 5xx but no merge SHA in flag; cannot auto-revert; manual investigation needed" >&2
    rm -f "$FLAG"
    exit 1
fi

# ── Revert the merge commit on preview ────────────────────────────────────────
echo "[post-merge-smoke] reverting merge commit ${MERGE_SHA} on ${PREVIEW_BRANCH}"

# Ensure we're on preview and up-to-date before reverting.
git -C "$REPO_DIR" fetch origin "$PREVIEW_BRANCH"
git -C "$REPO_DIR" checkout "$PREVIEW_BRANCH"
git -C "$REPO_DIR" reset --hard "origin/${PREVIEW_BRANCH}"

# -m 1: for a merge commit, use the first parent (the integration branch tip)
# as the mainline so we revert the merged content.
if ! git -C "$REPO_DIR" revert -m 1 --no-edit "$MERGE_SHA"; then
    # Revert had conflicts — abort and bail loudly.
    conflict_files=$(git -C "$REPO_DIR" diff --name-only --diff-filter=U 2>/dev/null | head -20 || true)
    echo "[post-merge-smoke] revert failed — manual intervention needed" >&2
    echo "[post-merge-smoke] conflict files:" >&2
    echo "$conflict_files" >&2
    git -C "$REPO_DIR" revert --abort 2>/dev/null || true
    # Re-queue reload (empty flag) so next cron restarts; at least tries.
    touch "$FLAG"
    exit 1
fi

REVERT_SHA=$(git -C "$REPO_DIR" rev-parse HEAD)
echo "[post-merge-smoke] revert commit: ${REVERT_SHA}"

# Push the revert to origin.
if ! git -C "$REPO_DIR" push origin "$PREVIEW_BRANCH"; then
    echo "[post-merge-smoke] git push after revert failed — manual intervention needed" >&2
    touch "$FLAG"
    exit 1
fi

echo "[post-merge-smoke] pushed revert ${REVERT_SHA} to origin/${PREVIEW_BRANCH}"

# ── Gather context for the issue ──────────────────────────────────────────────
PR_NUMBER=""
PR_TITLE=""
PR_URL=""

if [[ -n "$FGIT_TOKEN" ]]; then
    searched=$(curl -sS \
        -H "Authorization: token ${FGIT_TOKEN}" \
        -H "Accept: application/json" \
        "https://${FGIT_HOST}/api/v1/repos/${FGIT_REPO}/pulls?state=closed&limit=50&type=comment" \
        2>/dev/null) || searched="[]"

    PR_NUMBER=$(python3 - "$MERGE_SHA" "$searched" <<'PYEOF'
import sys, json
merge_sha = sys.argv[1]
try:
    pulls = json.loads(sys.argv[2])
except Exception:
    pulls = []
for pr in pulls if isinstance(pulls, list) else []:
    if pr.get("merge_commit_sha", "").startswith(merge_sha[:12]) or \
       pr.get("merge_commit_sha") == merge_sha:
        print(pr.get("number", ""))
        break
PYEOF
    ) || PR_NUMBER=""

    if [[ -n "$PR_NUMBER" ]]; then
        pr_info=$(curl -sS \
            -H "Authorization: token ${FGIT_TOKEN}" \
            -H "Accept: application/json" \
            "https://${FGIT_HOST}/api/v1/repos/${FGIT_REPO}/pulls/${PR_NUMBER}" \
            2>/dev/null) || pr_info="{}"
        PR_TITLE=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(d.get('title',''))" "$pr_info" 2>/dev/null || true)
        PR_URL=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(d.get('html_url',''))" "$pr_info" 2>/dev/null || true)
    fi
fi

# Fall back: extract title from commit message first line.
if [[ -z "$PR_TITLE" ]]; then
    PR_TITLE=$(git -C "$REPO_DIR" log -1 --pretty=format:"%s" "$MERGE_SHA" 2>/dev/null || echo "unknown")
fi

# ── Collect failing page details ──────────────────────────────────────────────
failing_details=""
for path in "${FAILED_PATHS[@]}"; do
    failing_details+="**${path}** → HTTP ${FAILED_STATUS[$path]}\n\`\`\`\n${FAILED_BODY[$path]}\n\`\`\`\n\n"
done

# Last 50 lines of postiz log.
postiz_tail=""
if [[ -f "$POSTIZ_LOG" ]]; then
    postiz_tail=$(tail -n 50 "$POSTIZ_LOG" 2>/dev/null || true)
fi

# ── Build reproduction block ──────────────────────────────────────────────────
safe_pr="${PR_NUMBER:-unknown}"
repro_block="\`\`\`bash
cd /home/dev/src/fgit.datafor.xyz/datafor/postiz-app
git fetch origin
# Recreate the branch at the reverted commit for debugging:
git worktree add -b debug/${safe_pr}-revert /home/dev/worktrees/debug-${safe_pr} ${MERGE_SHA}
cd /home/dev/worktrees/debug-${safe_pr}
pnpm install --frozen-lockfile && pnpm build   # reproduce the build
# Fix, then branch off current preview and PR again:
git branch -D debug/${safe_pr}-revert
git worktree remove /home/dev/worktrees/debug-${safe_pr}
git worktree add -b fix/${safe_pr}-retry /home/dev/worktrees/retry-${safe_pr} origin/dev/all-open-prs-preview
\`\`\`"

# ── File a Forgejo issue ──────────────────────────────────────────────────────
ISSUE_NUMBER=""
if [[ -n "$FGIT_TOKEN" ]]; then
    pr_ref=""
    if [[ -n "$PR_URL" ]]; then
        pr_ref="**Original PR:** ${PR_URL}"
    elif [[ -n "$PR_NUMBER" ]]; then
        pr_ref="**Original PR:** #${PR_NUMBER}"
    else
        pr_ref="**Merge SHA:** \`${MERGE_SHA}\`"
    fi

    issue_body="## Auto-revert triggered by post-merge smoke failure

${pr_ref}

**Merge SHA reverted:** \`${MERGE_SHA}\`
**Revert SHA now on preview:** \`${REVERT_SHA}\`

## Failing pages

${failing_details}

## Last 50 lines of postiz log

\`\`\`
${postiz_tail}
\`\`\`

## Reproduction

${repro_block}

---
*Filed automatically by \`scripts/reload_on_merge.sh\` post-merge smoke test.*"

    issue_title="auto-revert: ${PR_TITLE}"

    issue_payload=$(python3 -c '
import sys, json
title = sys.argv[1]
body = sys.argv[2]
print(json.dumps({"title": title, "body": body}))
' "$issue_title" "$issue_body")

    issue_resp=$(curl -sS -X POST \
        -H "Authorization: token ${FGIT_TOKEN}" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        "https://${FGIT_HOST}/api/v1/repos/${FGIT_REPO}/issues" \
        -d "$issue_payload" 2>/dev/null) || issue_resp="{}"

    ISSUE_NUMBER=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(d.get('number',''))" "$issue_resp" 2>/dev/null || true)

    if [[ -n "$ISSUE_NUMBER" ]]; then
        echo "[post-merge-smoke] filed issue #${ISSUE_NUMBER}"

        # Try to apply "auto-revert" label by name using labels search.
        label_id=$(curl -sS \
            -H "Authorization: token ${FGIT_TOKEN}" \
            -H "Accept: application/json" \
            "https://${FGIT_HOST}/api/v1/repos/${FGIT_REPO}/labels?limit=50" \
            2>/dev/null \
            | python3 -c '
import sys, json
try:
    labels = json.load(sys.stdin)
except Exception:
    labels = []
for l in labels if isinstance(labels, list) else []:
    if l.get("name","").lower() == "auto-revert":
        print(l["id"])
        break
' 2>/dev/null) || label_id=""

        if [[ -n "$label_id" ]]; then
            curl -sS -X POST \
                -H "Authorization: token ${FGIT_TOKEN}" \
                -H "Content-Type: application/json" \
                -H "Accept: application/json" \
                "https://${FGIT_HOST}/api/v1/repos/${FGIT_REPO}/issues/${ISSUE_NUMBER}/labels" \
                -d "{\"labels\":[${label_id}]}" >/dev/null 2>&1 || true
        fi
    else
        echo "[post-merge-smoke] WARN: Forgejo issue creation failed — revert was pushed, but no issue filed" >&2
        echo "[post-merge-smoke] issue_resp: ${issue_resp}" >&2
    fi
else
    echo "[post-merge-smoke] WARN: no FGIT_TOKEN — could not file Forgejo issue" >&2
fi

# ── Re-queue the reload (empty flag) so next cron restarts onto reverted code ─
touch "$FLAG"
echo "[post-merge-smoke] re-queued reload flag (empty) for rollback restart"

echo "[post-merge-smoke] reverted ${MERGE_SHA} → ${REVERT_SHA}; filed issue #${ISSUE_NUMBER:-<none>}; re-queued reload"
exit 0
