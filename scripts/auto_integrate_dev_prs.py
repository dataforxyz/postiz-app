#!/usr/bin/env python3
"""Automatically integrate open PRs targeting the dev integration branch.

Intended to be run from cron (every 2 minutes via flock). For each open PR
targeting ``dev/all-open-prs-preview``:

1. Checks that the baseline (current preview HEAD) passes the pnpm verify
   pipeline — if not, bails cleanly so PRs aren't blamed for a pre-existing
   red baseline.
2. Creates a disposable worktree at the current preview HEAD.
3. Merges the PR branch into the worktree, runs ``scripts/integrator_verify.sh``.
4. If green: calls Forgejo's PR merge API with ``Do: rebase`` so the PR
   records ``merged=true`` and the source branch is auto-deleted by repo
   settings.
5. If red: comments the failure on the PR (deduped by head SHA) and
   continues to the next PR — one bad PR does not block the queue.

Verify pipeline (delegated to scripts/integrator_verify.sh):
    pnpm install --frozen-lockfile
    pnpm -r run typecheck  (or root typecheck if no per-package script)
    pnpm lint              (skipped if no root lint script)
    pnpm test              (skipped if no root test script)
    pnpm build             (the Docker Build CI gate — always runs)

On transient Forgejo / network errors the script retries with exponential
backoff, then skips that PR for this run.

Cron lock file: /tmp/postiz-app-auto-integrate.lock
Kill switch:    /tmp/postiz-app-integrator-stop
Dry-run env:    INTEGRATOR_DRY_RUN=1  (or --dry-run flag)
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

# Line-buffer stdout so progress shows up in cron logs immediately
# instead of only on script exit.
sys.stdout.reconfigure(line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BRANCH = "dev/all-open-prs-preview"
DEFAULT_VERIFY = str(REPO_ROOT / "scripts" / "integrator_verify.sh")
DEFAULT_HOST = "fgit.datafor.xyz"
DEFAULT_REPO = "datafor/postiz-app"
DEFAULT_MERGE_STYLE = "rebase"  # rebase | merge | squash | rebase-merge

# ── cache configuration ───────────────────────────────────────────────────────

_CACHE_DIR = REPO_ROOT / "logs" / "integrator_cache"

# TTLs in seconds
_BASELINE_GREEN_TTL = 3600  # 1h
_BASELINE_RED_TTL = 300  # 5m — retry quickly after fix push
_PR_GREEN_TTL = 3600  # 1h

_BASELINE_CACHE_FILE = _CACHE_DIR / "baseline_verify.json"
_PR_CACHE_FILE = _CACHE_DIR / "pr_verify.json"

# ── per-section timing context ────────────────────────────────────────────────


@contextlib.contextmanager
def timing(name: str):
    """Context manager that logs stage=<name> duration_ms=<n> on exit."""
    t0 = time.monotonic()
    try:
        yield
    finally:
        ms = int((time.monotonic() - t0) * 1000)
        print(f"stage={name} duration_ms={ms}", flush=True)


# ── cache I/O helpers ─────────────────────────────────────────────────────────


def _ensure_cache_dir() -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _load_json_cache(path: Path) -> dict:
    """Load JSON cache file, returning {} on missing/corrupt."""
    try:
        raw = path.read_text()
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {}


def _save_json_cache(path: Path, data: dict) -> None:
    """Atomically write JSON cache; non-fatal on failure."""
    _ensure_cache_dir()
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(path)
    except OSError as exc:
        print(f"  [cache-warn] could not write {path.name}: {exc}")


def _bust_cache_key(path: Path, key: str) -> None:
    """Remove a single key from a JSON cache file (fail-open on error)."""
    try:
        data = _load_json_cache(path)
        if key in data:
            del data[key]
            _save_json_cache(path, data)
    except Exception:
        pass


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _age_seconds(iso_ts: str) -> float:
    """Return seconds since iso_ts. Returns inf on parse error."""
    try:
        dt = datetime.datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        return (datetime.datetime.now(datetime.timezone.utc) - dt).total_seconds()
    except Exception:
        return float("inf")


# ── baseline cache ────────────────────────────────────────────────────────────


def _pnpm_lock_hash() -> str:
    """sha256 of pnpm-lock.yaml + package.json for cache invalidation.

    Replaces juston-app's pyproject_uv_hash — same purpose but for pnpm.
    """
    h = hashlib.sha256()
    for fname in ("pnpm-lock.yaml", "package.json"):
        p = REPO_ROOT / fname
        try:
            h.update(p.read_bytes())
        except OSError:
            h.update(fname.encode())
    return h.hexdigest()[:16]


def load_baseline_cache(branch_sha: str) -> dict | None:
    """Return cached baseline entry if still valid, else None.

    Entry is invalid if:
    - SHA doesn't match
    - pnpm-lock.yaml / package.json hash changed
    - TTL expired (1h green, 5m red)
    - baseline-red-clear override file present (clear on read)
    """
    data = _load_json_cache(_BASELINE_CACHE_FILE)
    entry = data.get(branch_sha)
    if not isinstance(entry, dict):
        return None
    if entry.get("sha") != branch_sha:
        return None
    if entry.get("pnpm_lock_hash") != _pnpm_lock_hash():
        return None
    result = entry.get("result", "red")
    ttl = _BASELINE_GREEN_TTL if result == "green" else _BASELINE_RED_TTL
    if _age_seconds(entry.get("verified_at_iso", "")) > ttl:
        return None
    # Check clear-override
    if _BASELINE_RED_CLEAR.exists():
        _clear_baseline_red()
        _bust_cache_key(_BASELINE_CACHE_FILE, branch_sha)
        print("[cache] baseline-red-clear override → busting baseline cache")
        return None
    return entry


def save_baseline_cache(branch_sha: str, result: str) -> None:
    data = _load_json_cache(_BASELINE_CACHE_FILE)
    data[branch_sha] = {
        "sha": branch_sha,
        "verified_at_iso": _now_iso(),
        "result": result,
        "pnpm_lock_hash": _pnpm_lock_hash(),
    }
    _save_json_cache(_BASELINE_CACHE_FILE, data)


# ── per-PR green cache ────────────────────────────────────────────────────────


def load_pr_cache(pr_number: int, head_sha: str, base_sha: str) -> dict | None:
    """Return cached PR entry if pr+head+base SHA all match and within TTL."""
    data = _load_json_cache(_PR_CACHE_FILE)
    entry = data.get(str(pr_number))
    if not isinstance(entry, dict):
        return None
    if entry.get("head_sha") != head_sha:
        return None
    if entry.get("base_sha") != base_sha:
        return None
    result = entry.get("result", "red")
    ttl = _PR_GREEN_TTL if result == "green" else 0  # red entries not cached
    if _age_seconds(entry.get("verified_at_iso", "")) > ttl:
        return None
    return entry


def save_pr_cache(pr_number: int, head_sha: str, base_sha: str, result: str) -> None:
    """Save a PR verification result (only green results are useful to cache)."""
    if result != "green":
        return  # don't cache red — let it retry
    data = _load_json_cache(_PR_CACHE_FILE)
    data[str(pr_number)] = {
        "head_sha": head_sha,
        "base_sha": base_sha,
        "verified_at_iso": _now_iso(),
        "result": result,
    }
    _save_json_cache(_PR_CACHE_FILE, data)


# Comment sentinel so we only post one failure comment per head SHA per reason.
COMMENT_SENTINEL = "<!-- auto-integrator:{reason}:{sha} -->"

# ── loop-guard constants ──────────────────────────────────────────────────────

# Trailer appended to every merge commit message so we can detect self-triggered
# webhook events. The integrator looks for this tag in recent commit messages.
INTEGRATOR_COMMIT_TRAILER = "Integrator-Run: auto"

# Default maximum number of merges allowed per 60-minute rolling window.
_DEFAULT_MAX_MERGES_PER_HOUR = 30

# Log file for merge timestamps (ISO-8601 lines, one per merge).
_MERGE_LOG_PATH = REPO_ROOT / "logs" / "integrator_merges.log"


@dataclass
class PullRequest:
    number: int
    title: str
    head_ref: str
    head_sha: str
    base_ref: str
    html_url: str
    draft: bool


# ── shell helpers ─────────────────────────────────────────────────────────────


def run(cmd: list[str], *, cwd: Path = REPO_ROOT, check: bool = True):
    return subprocess.run(
        cmd, cwd=str(cwd), check=check, text=True, capture_output=True
    )


def shell(
    cmd: str, *, cwd: Path = REPO_ROOT, check: bool = False, timeout: int | None = None
):
    try:
        return subprocess.run(
            cmd,
            cwd=str(cwd),
            shell=True,
            executable="/bin/bash",
            check=check,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(
            args=cmd,
            returncode=124,
            stdout=(
                (exc.stdout or b"").decode("utf-8", "replace")
                if isinstance(exc.stdout, bytes)
                else (exc.stdout or "")
            ),
            stderr=f"timeout after {timeout}s",
        )


def truncate(text: str, limit: int = 4000) -> str:
    return text if len(text) <= limit else text[-limit:]


# ── Forgejo API ───────────────────────────────────────────────────────────────


def infer_token() -> str:
    token = os.environ.get("FORGEJO_TOKEN", "").strip()
    if token:
        return token
    remote = run(["git", "remote", "get-url", "origin"]).stdout.strip()
    m = re.match(r"https://[^:]+:([^@]+)@[^/]+/.+", remote)
    if m:
        return urllib.parse.unquote(m.group(1))
    raise SystemExit("error: FORGEJO_TOKEN not set and could not infer from origin URL")


def infer_repo() -> tuple[str, str]:
    host = os.environ.get("FORGEJO_HOST", DEFAULT_HOST)
    repo = os.environ.get("FORGEJO_REPO", DEFAULT_REPO)
    remote = run(["git", "remote", "get-url", "origin"]).stdout.strip()
    m = re.match(r"https://[^@]+@([^/]+)/([^/]+/[^/.]+)(?:\\.git)?$", remote)
    if m:
        host, repo = m.group(1), m.group(2)
    return host, repo


def api(
    host: str,
    token: str,
    method: str,
    path: str,
    payload: dict | None = None,
    *,
    retries: int = 3,
) -> object | None:
    data = None
    headers = {"Authorization": f"token {token}", "Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    url = f"https://{host}{path}"

    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                body = resp.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            if 400 <= exc.code < 500:
                raise RuntimeError(f"{method} {path} -> {exc.code}: {body}") from exc
            if attempt == retries - 1:
                raise RuntimeError(f"{method} {path} -> {exc.code}: {body}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == retries - 1:
                raise RuntimeError(f"{method} {path} -> network: {exc}") from exc
        time.sleep(4**attempt)  # 1s, 4s, 16s
    return None


def list_open_prs(host: str, token: str, repo: str, base: str) -> list[PullRequest]:
    encoded = urllib.parse.quote(base, safe="")
    data = api(
        host,
        token,
        "GET",
        f"/api/v1/repos/{repo}/pulls?state=open&limit=100&base={encoded}",
    )
    pulls: list[PullRequest] = []
    for raw in data or []:
        if not isinstance(raw, dict) or raw.get("draft"):
            continue
        # Defensive: Forgejo's ?base= filter is sometimes ignored and returns
        # PRs targeting other branches (e.g. release-rc→main leaking into a
        # dev/all-open-prs-preview query). Re-check client-side so the
        # integrator never processes a PR aimed at the wrong base.
        actual_base = str((raw.get("base") or {}).get("ref") or "")
        if actual_base != base:
            continue
        pulls.append(
            PullRequest(
                number=int(raw["number"]),
                title=str(raw.get("title") or ""),
                head_ref=str((raw.get("head") or {}).get("ref") or ""),
                head_sha=str((raw.get("head") or {}).get("sha") or ""),
                base_ref=actual_base,
                html_url=str(raw.get("html_url") or ""),
                draft=False,
            )
        )
    pulls.sort(key=lambda pr: pr.number)
    return pulls


def list_pr_dependencies(
    host: str, token: str, repo: str, pr_number: int
) -> list[dict]:
    data = api(
        host, token, "GET", f"/api/v1/repos/{repo}/issues/{pr_number}/dependencies"
    )
    return [d for d in (data or []) if isinstance(d, dict)]


def list_pr_changed_files(
    host: str, token: str, repo: str, pr_number: int
) -> list[str]:
    """Fetch the list of changed file paths for a PR via Forgejo API."""
    data = api(
        host, token, "GET", f"/api/v1/repos/{repo}/pulls/{pr_number}/files?limit=5000"
    )
    paths: list[str] = []
    for item in data or []:
        if isinstance(item, dict):
            fn = item.get("filename") or ""
            if fn:
                paths.append(fn)
    if len(paths) >= 5000:
        print(
            f"  [warn] PR #{pr_number} has ≥5000 changed files; gate tier may be incorrect"
        )
    return paths


TIER_COST = {"docs": 0, "source": 1, "build": 2}


def sort_by_gate_cost(
    pulls: list[PullRequest], host: str, token: str, repo: str
) -> list[tuple[PullRequest, str, list[str]]]:
    """Annotate each PR with its gate tier, sort cheapest first."""
    annotated: list[tuple[PullRequest, str, list[str]]] = []
    for pr in pulls:
        try:
            changed = list_pr_changed_files(host, token, repo, pr.number)
        except Exception as exc:
            print(f"  [warn] could not list files for PR #{pr.number}: {exc}")
            changed = []
        tier, _cmds = pick_gate(changed)
        annotated.append((pr, tier, changed))
    annotated.sort(key=lambda t: (TIER_COST.get(t[1], 99), t[0].number))
    return annotated


def comment(host: str, token: str, repo: str, pr_number: int, body: str) -> None:
    api(
        host,
        token,
        "POST",
        f"/api/v1/repos/{repo}/issues/{pr_number}/comments",
        {"body": body},
    )


def list_comments(host: str, token: str, repo: str, pr_number: int) -> list[dict]:
    data = api(host, token, "GET", f"/api/v1/repos/{repo}/issues/{pr_number}/comments")
    return [c for c in (data or []) if isinstance(c, dict)]


def already_rejected_at_sha(
    host: str, token: str, repo: str, pr_number: int, head_sha: str
) -> str | None:
    """Return the reason we already rejected this exact head SHA, or None."""
    prefix = "<!-- auto-integrator:"
    short = head_sha[:12]
    for c in list_comments(host, token, repo, pr_number):
        body = c.get("body") or ""
        if prefix in body and f":{short} -->" in body:
            try:
                sentinel = body[body.index(prefix) :].split("-->", 1)[0] + "-->"
                reason = sentinel.split(":")[1]
                return reason
            except Exception:
                return "rejected"
    return None


def comment_once_for_sha(
    host: str,
    token: str,
    repo: str,
    pr_number: int,
    reason: str,
    head_sha: str,
    body: str,
) -> None:
    """Post a comment only if we haven't already commented about this (reason, sha)."""
    sentinel = COMMENT_SENTINEL.format(reason=reason, sha=head_sha[:12])
    for c in list_comments(host, token, repo, pr_number):
        if sentinel in (c.get("body") or ""):
            return
    comment(host, token, repo, pr_number, f"{sentinel}\n\n{body}")


def merge_pr(
    host: str, token: str, repo: str, pr_number: int, style: str = DEFAULT_MERGE_STYLE
) -> None:
    """Merge a PR via the Forgejo API."""
    try:
        api(
            host,
            token,
            "POST",
            f"/api/v1/repos/{repo}/pulls/{pr_number}/merge",
            {
                "Do": style,
                "delete_branch_after_merge": True,
                "merge_message_field": INTEGRATOR_COMMIT_TRAILER,
            },
        )
    except RuntimeError as exc:
        msg = str(exc).lower()
        if "already merged" in msg or "has already been merged" in msg:
            return  # idempotent
        raise


def _is_transient_merge_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "try again later" in msg or " 405" in str(exc) or "423" in str(exc)


def merge_pr_with_retry(
    host: str, token: str, repo: str, pr_number: int, style: str = DEFAULT_MERGE_STYLE
) -> None:
    """Call merge_pr with inline backoff retry on transient 405 / lock errors."""
    delays = [0.0, 1.0, 3.0, 10.0]
    last_exc: Exception | None = None
    for d in delays:
        if d > 0:
            time.sleep(d)
        try:
            merge_pr(host, token, repo, pr_number, style)
            return
        except RuntimeError as exc:
            if _is_transient_merge_error(exc):
                last_exc = exc
                continue
            raise
    raise last_exc or RuntimeError("merge_pr_with_retry: exhausted all attempts")


def get_pr(host: str, token: str, repo: str, pr_number: int) -> dict:
    data = api(host, token, "GET", f"/api/v1/repos/{repo}/pulls/{pr_number}")
    return data if isinstance(data, dict) else {}


# ── loop-guard helpers ────────────────────────────────────────────────────────


def is_self_webhook_trigger() -> bool:
    """Return True if this run was triggered by a webhook from our own merge."""
    trigger = os.environ.get("INTEGRATOR_TRIGGER", "").strip().lower()
    if trigger != "webhook":
        return False

    sha = os.environ.get("INTEGRATOR_TRIGGER_SHA", "").strip()
    if not sha:
        print(
            "[loop-guard] INTEGRATOR_TRIGGER=webhook but INTEGRATOR_TRIGGER_SHA not set; "
            "skipping self-trigger check"
        )
        return False

    try:
        result = run(["git", "log", "-1", "--format=%B", sha], check=False)
        commit_body = result.stdout or ""
    except Exception as exc:
        print(
            f"[loop-guard] could not inspect commit {sha[:12]}: {exc}; skipping self-trigger check"
        )
        return False

    if INTEGRATOR_COMMIT_TRAILER in commit_body:
        print(
            f"[loop-guard] webhook triggered by our own merge commit {sha[:12]} "
            f"(found '{INTEGRATOR_COMMIT_TRAILER}' in message); skipping run to prevent loop"
        )
        return True

    return False


def record_merge_timestamp(merge_log: Path = _MERGE_LOG_PATH) -> None:
    """Append an ISO-8601 UTC timestamp to the merge log (one line per merge)."""
    try:
        merge_log.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with merge_log.open("a") as fh:
            fh.write(ts + "\n")
    except OSError as exc:
        print(f"  [warn] could not write merge timestamp to {merge_log}: {exc}")


def _read_merge_timestamps(
    merge_log: Path = _MERGE_LOG_PATH,
) -> list[datetime.datetime]:
    """Return timestamps from the merge log that fall within the last 60 minutes."""
    if not merge_log.exists():
        return []
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(hours=1)
    recent: list[datetime.datetime] = []
    try:
        with merge_log.open() as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    ts = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    if ts > cutoff:
                        recent.append(ts)
                except ValueError:
                    pass
    except OSError:
        pass
    return recent


def check_cycle_limit(merge_log: Path = _MERGE_LOG_PATH) -> bool:
    """Return True if the integrator has already hit its per-hour merge cap."""
    try:
        cap = int(
            os.environ.get(
                "INTEGRATOR_MAX_MERGES_PER_HOUR", _DEFAULT_MAX_MERGES_PER_HOUR
            )
        )
    except ValueError:
        cap = _DEFAULT_MAX_MERGES_PER_HOUR

    recent = _read_merge_timestamps(merge_log)
    count = len(recent)
    if count >= cap:
        print(
            f"[loop-guard] cycle-limit reached: {count}/{cap} merges in last 60 min; "
            f"refusing to run (set INTEGRATOR_MAX_MERGES_PER_HOUR to raise the cap)"
        )
        return True
    return False


# ── /tmp state file paths ─────────────────────────────────────────────────────

_BASELINE_RED_UNTIL = Path("/tmp/postiz-app-integrator-baseline-red-until")
_BASELINE_RED_CLEAR = Path("/tmp/postiz-app-integrator-baseline-red-clear")
_PR_ATTEMPTS_FILE = Path("/tmp/postiz-app-integrator-pr-attempts.json")
_KILL_SWITCH = Path("/tmp/postiz-app-integrator-stop")
_RELOAD_PENDING = Path("/tmp/postiz-app-integrator-reload-pending")


def _write_reload_pending(merge_sha: str) -> None:
    """Write the reload-pending flag with the merge commit SHA.

    Idempotent: if the flag already contains this exact SHA, does nothing.
    Called after every successful merge so reload_on_merge.sh can pick up
    the new code and restart the running postiz services.
    """
    sha = (merge_sha or "").strip()
    try:
        existing = _RELOAD_PENDING.read_text().strip() if _RELOAD_PENDING.exists() else ""
        if existing and existing == sha:
            return  # already queued for this SHA
    except OSError:
        pass
    try:
        _RELOAD_PENDING.write_text(sha + "\n")
        print(f"  [reload-pending] wrote {_RELOAD_PENDING} (sha={sha[:12] if sha else '<empty>'})")
    except OSError as exc:
        print(f"  [warn] could not write reload-pending flag: {exc}")


# ── baseline backoff helpers ──────────────────────────────────────────────────


def _write_baseline_red_until() -> None:
    """Record that the baseline is suspected red for the next hour."""
    _BASELINE_RED_UNTIL.write_text(str(int(time.time()) + 3600))


def _clear_baseline_red() -> None:
    """Remove the baseline-red sentinel."""
    for p in (_BASELINE_RED_UNTIL, _BASELINE_RED_CLEAR):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def check_baseline_backoff() -> bool:
    """Return True if the cycle should be skipped due to a recent red baseline."""
    if not _BASELINE_RED_UNTIL.exists():
        return False
    if _BASELINE_RED_CLEAR.exists():
        print("[backoff] baseline-red-clear override detected; resuming")
        _clear_baseline_red()
        return False
    try:
        until = int(_BASELINE_RED_UNTIL.read_text().strip())
    except (ValueError, OSError):
        return False
    if time.time() < until:
        until_str = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until))
        print(
            f"[backoff] baseline still suspected red until {until_str}; "
            f"skipping this cycle "
            f"(touch {_BASELINE_RED_CLEAR} to override)"
        )
        return True
    _clear_baseline_red()
    return False


# ── per-PR rate-limit helpers ─────────────────────────────────────────────────


def _load_pr_attempts() -> dict[str, list[float]]:
    try:
        raw = _PR_ATTEMPTS_FILE.read_text()
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {}


def _save_pr_attempts(attempts: dict[str, list[float]]) -> None:
    try:
        _PR_ATTEMPTS_FILE.write_text(json.dumps(attempts))
    except OSError as exc:
        print(f"  [warn] could not write pr-attempts file: {exc}")


def check_pr_rate_limit(pr_number: int) -> bool:
    """Return True if this PR has been tested >= 3 times in the last hour."""
    now = time.time()
    cutoff = now - 3600
    attempts = _load_pr_attempts()
    key = str(pr_number)
    recent = [t for t in attempts.get(key, []) if t > cutoff]
    attempts[key] = recent
    _save_pr_attempts(attempts)
    if len(recent) >= 3:
        oldest = min(recent)
        until_str = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(oldest + 3600))
        print(
            f"  [rate-limit] PR #{pr_number} tested {len(recent)} times in last hour; "
            f"skipping until {until_str}"
        )
        return True
    return False


def record_pr_attempt(pr_number: int) -> None:
    """Append current timestamp to the PR's attempt list."""
    now = time.time()
    cutoff = now - 3600
    attempts = _load_pr_attempts()
    key = str(pr_number)
    recent = [t for t in attempts.get(key, []) if t > cutoff]
    recent.append(now)
    attempts[key] = recent
    _save_pr_attempts(attempts)


# ── baseline + per-PR test ────────────────────────────────────────────────────


def get_branch_sha(branch: str) -> str:
    """Return the current remote SHA for branch (fetches first)."""
    run(["git", "fetch", "origin", branch])
    result = run(["git", "rev-parse", f"origin/{branch}"])
    return result.stdout.strip()


def _ff_or_recover(branch: str) -> None:
    """Fast-forward local <branch> to origin/<branch>. If the local branch has
    diverged (committed work that isn't on origin), save those commits to a
    labeled side branch on origin and hard-reset local. Mirrors the
    auto-stash pattern in ensure_clean_tree."""
    fetch_res = run(["git", "fetch", "origin", branch], check=False)
    if fetch_res.returncode != 0:
        # Network blip — let the next caller see the failure normally.
        run(["git", "fetch", "origin", branch])
        return
    # Try the fast-forward first.
    pull = run(["git", "pull", "--ff-only", "origin", branch], check=False)
    if pull.returncode == 0:
        return
    # Diverged — count ahead/behind to decide.
    counts = run(
        [
            "git",
            "rev-list",
            "--left-right",
            "--count",
            f"HEAD...origin/{branch}",
        ],
        check=False,
    )
    parts = counts.stdout.strip().split()
    if len(parts) != 2 or parts[0] == "0":
        # Behind only or unparseable — re-raise normal pull error.
        run(["git", "pull", "--ff-only", "origin", branch])
        return
    ahead = int(parts[0])
    label = f"auto-integrator-stranded-{_now_iso().replace(':', '-')}"
    head = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    print(
        f"[auto-recover] local {branch} ahead by {ahead}; "
        f"saving stranded commits to '{label}' on origin and resetting."
    )
    print("  stranded HEAD:", head[:12])
    # Make a branch pointing at the stranded HEAD, push it to origin so the
    # commits are recoverable, then hard-reset local to origin.
    run(["git", "branch", label, head], check=False)
    push = run(["git", "push", "origin", f"refs/heads/{label}"], check=False)
    if push.returncode != 0:
        # Couldn't preserve — bail loudly so user sees the issue rather
        # than silently losing commits.
        raise SystemExit(
            f"error: local {branch} diverged AND we could not push the "
            f"stranded label '{label}' to origin. Refusing to reset. "
            f"Manual intervention required.\n" + (push.stderr or "")
        )
    # Now safe to hard-reset.
    run(["git", "reset", "--hard", f"origin/{branch}"])
    print(
        f"[auto-recover] local {branch} reset to origin/{branch}; "
        f"recover the {ahead} stranded commit(s) at "
        f"`git fetch origin {label}` (also at refs/heads/{label} on the remote)."
    )


def verify_baseline(
    verify_cmd: str, branch: str, timeout: int | None = None, use_cache: bool = True
) -> tuple[bool, str]:
    """Run verify on the current preview HEAD before processing any PR.

    verify_cmd is the path to integrator_verify.sh (or override).
    When use_cache=True, checks baseline_verify.json first.
    """
    run(["git", "fetch", "origin", branch])
    run(["git", "checkout", branch])
    _ff_or_recover(branch)

    branch_sha = get_branch_sha(branch)

    if use_cache:
        cached = load_baseline_cache(branch_sha)
        if cached is not None:
            result_str = cached.get("result", "red")
            age = int(_age_seconds(cached.get("verified_at_iso", "")))
            print(
                f"[cache-hit] baseline sha={branch_sha[:12]} result={result_str} age={age}s → skip verify"
            )
            if result_str == "green":
                return True, ""
            return False, "[cached-red] baseline previously failed; waiting for fix"

    # Not cached — run the full baseline verify
    with timing("baseline-verify"):
        result = shell(f'bash "{verify_cmd}" "{REPO_ROOT}"', timeout=timeout)
    ok = result.returncode == 0
    detail = (
        "" if ok else truncate((result.stdout or "") + "\n" + (result.stderr or ""))
    )

    result_str = "green" if ok else "red"
    save_baseline_cache(branch_sha, result_str)

    if ok:
        return True, ""
    return False, detail


# ── gate chain: pick verify steps based on what the PR changed ────────────────

# Files/patterns whose presence in a PR marks it as "build-affecting"
BUILD_AFFECTING = (
    "Dockerfile",
    ".dockerignore",
    "pnpm-lock.yaml",
    "package.json",
    "tsconfig",
    "jest.config",
    "eslint.config",
    "prisma/schema",
)


def pick_gate(changed_paths: list[str]) -> tuple[str, list[str]]:
    """Return (tier_name, list_of_verify_commands) based on what the PR touched.

    Tiers for postiz-app (all tiers call integrator_verify.sh):
      - "docs": docs-only (markdown, docs/) → verify (install + typecheck only)
      - "source": TS/config change → full verify (install, typecheck, lint, test, build)
      - "build": touches Dockerfile/lockfile/tsconfig → same as source (full verify)

    All tiers run the same shell wrapper — the distinction is informational for
    logging and future differentiation. The full build is always required because
    the Docker CI gate runs pnpm build.
    """
    verify_cmd = str(REPO_ROOT / "scripts" / "integrator_verify.sh")
    if not changed_paths:
        return "source", [f'bash "{verify_cmd}"']
    docs_only = all(p.endswith(".md") or p.startswith("docs/") for p in changed_paths)
    touches_build = any(any(b in p for b in BUILD_AFFECTING) for p in changed_paths)
    if touches_build:
        return "build", [f'bash "{verify_cmd}"']
    if docs_only:
        return "docs", [f'bash "{verify_cmd}"']
    return "source", [f'bash "{verify_cmd}"']


def test_pr_in_worktree(
    pr: PullRequest,
    branch: str,
    timeout: int | None = None,
    base_sha: str = "",
    use_cache: bool = True,
) -> tuple[bool, str]:
    """Create a temp worktree, merge PR branch in, run verify. Returns (ok, detail)."""
    if use_cache and base_sha:
        cached = load_pr_cache(pr.number, pr.head_sha, base_sha)
        if cached is not None:
            age = int(_age_seconds(cached.get("verified_at_iso", "")))
            print(
                f"  [cache-hit] PR #{pr.number} head={pr.head_sha[:12]} base={base_sha[:12]} age={age}s → skip verify"
            )
            return True, ""

    tmp = Path(tempfile.mkdtemp(prefix=f"integrator-pr{pr.number}-"))
    try:
        run(["git", "fetch", "origin", branch])
        run(["git", "worktree", "add", "--detach", str(tmp), f"origin/{branch}"])
        run(["git", "fetch", "origin", pr.head_ref], cwd=tmp)
        merge = run(
            ["git", "merge", "--no-ff", "--no-edit", "FETCH_HEAD"], cwd=tmp, check=False
        )
        if merge.returncode != 0:
            return False, "merge-conflict:\n" + truncate(
                (merge.stdout or "") + "\n" + (merge.stderr or "")
            )

        diff = run(["git", "diff", "--name-only", f"origin/{branch}", "HEAD"], cwd=tmp)
        changed = [p for p in diff.stdout.splitlines() if p.strip()]
        tier, cmds = pick_gate(changed)
        print(f"  gate-tier={tier} ({len(changed)} file(s) changed): {', '.join(cmds)}")

        ok = True
        detail = ""
        for cmd in cmds:
            # Pass the tmp worktree path as argument to verify script
            verify_cmd_with_dir = f'{cmd} "{tmp}"'
            with timing(f"pr{pr.number}-verify"):
                verify = shell(verify_cmd_with_dir, cwd=tmp, timeout=timeout)
            if verify.returncode == 124:
                ok = False
                detail = (
                    f"verify-failed (timed out after {timeout}s):\n"
                    + truncate(verify.stderr or "")
                )
                break
            if verify.returncode != 0:
                ok = False
                detail = f"verify-failed:\n" + truncate(
                    (verify.stdout or "") + "\n" + (verify.stderr or "")
                )
                break

        if ok and base_sha:
            try:
                save_pr_cache(pr.number, pr.head_sha, base_sha, "green")
            except Exception as exc:
                print(f"  [cache-warn] could not write pr cache: {exc}")

        return ok, detail
    except Exception:
        _bust_cache_key(_PR_CACHE_FILE, str(pr.number))
        raise
    finally:
        shell(f'git worktree remove --force "{tmp}"', check=False)
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)


def clean_stale_tmp_worktrees() -> None:
    """Remove /tmp/integrator-pr*-* dirs older than 1 hour."""
    cutoff = time.time() - 3600
    for path in Path("/tmp").glob("integrator-pr*-*"):
        try:
            if path.stat().st_mtime < cutoff:
                shell(f'git worktree remove --force "{path}"', check=False)
                if path.exists():
                    shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


# ── main loop ─────────────────────────────────────────────────────────────────


def ensure_clean_tree() -> None:
    if run(["git", "status", "--porcelain"]).stdout.strip():
        raise SystemExit("error: working tree is not clean; refusing to auto-integrate")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--verify-command", default=DEFAULT_VERIFY)
    parser.add_argument(
        "--merge-style",
        default=DEFAULT_MERGE_STYLE,
        choices=["rebase", "merge", "squash", "rebase-merge"],
    )
    parser.add_argument(
        "--max-prs",
        type=int,
        default=10,
        help="Max PRs to process per cron cycle (default 10)",
    )
    parser.add_argument(
        "--verify-timeout",
        type=int,
        default=1800,
        help="Seconds before killing a stuck verify run (default 30 min)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    # Honour INTEGRATOR_DRY_RUN env var in addition to CLI flag
    dry_run = args.dry_run or os.environ.get("INTEGRATOR_DRY_RUN", "").strip() in (
        "1", "true", "yes",
    )

    # ── ensure log/cache dirs exist ───────────────────────────────────────────
    (REPO_ROOT / "logs").mkdir(parents=True, exist_ok=True)
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # ── kill-switch ───────────────────────────────────────────────────────────
    if _KILL_SWITCH.exists():
        print(f"[kill-switch] {_KILL_SWITCH} present; exiting without doing anything")
        return 0

    # ── loop-guard: self-webhook detection ────────────────────────────────────
    if is_self_webhook_trigger():
        return 0

    # ── loop-guard: per-hour cycle limiter ───────────────────────────────────
    if check_cycle_limit():
        return 3

    os.chdir(REPO_ROOT)
    ensure_clean_tree()
    clean_stale_tmp_worktrees()
    token = infer_token()
    host, repo = infer_repo()

    # ── token health check ────────────────────────────────────────────────────
    try:
        api(host, token, "GET", "/api/v1/user")
    except RuntimeError as exc:
        print(f"[auth] token health check failed: {exc}; exiting")
        return 0

    # ── disk-usage preflight ──────────────────────────────────────────────────
    for mount_path, label in [("/tmp", "/tmp"), (str(REPO_ROOT), "repo root")]:
        usage = shutil.disk_usage(mount_path)
        free_pct = usage.free / usage.total * 100 if usage.total else 100
        if free_pct < 10:
            print(f"[disk-preflight] {label} is {free_pct:.1f}% free; skipping cycle")
            return 0

    run(["git", "fetch", "origin", "--prune"])

    # ── queue-empty fast exit ─────────────────────────────────────────────────
    with timing("api-list-prs"):
        pulls_early = list_open_prs(host, token, repo, args.branch)
    if not pulls_early:
        print(f"queue-empty: no open PRs targeting {args.branch}; skipping baseline")
        return 0

    # ── baseline-red backoff ──────────────────────────────────────────────────
    if check_baseline_backoff():
        return 0

    # Baseline check
    if dry_run:
        print(f"[dry-run] skipping baseline verify (INTEGRATOR_DRY_RUN)")
        ok, detail = True, ""
    else:
        with timing("baseline"):
            ok, detail = verify_baseline(
                args.verify_command, args.branch, args.verify_timeout
            )
    if not ok:
        print(f"[baseline-red] {args.branch} fails verify pipeline")
        print(detail)
        _write_baseline_red_until()
        return 2
    if not dry_run:
        _clear_baseline_red()

    base_sha = run(["git", "rev-parse", f"origin/{args.branch}"]).stdout.strip()

    pulls = pulls_early
    if not pulls:
        print(f"no open PRs targeting {args.branch}")
        return 0

    with timing("api-sort-by-gate"):
        ranked = sort_by_gate_cost(pulls, host, token, repo)
    print(
        "queued (cost-order): "
        + ", ".join(f"#{pr.number}[{tier}]" for pr, tier, _ in ranked[: args.max_prs])
    )

    merged, rejected, skipped, cached = 0, 0, 0, 0
    for pr, tier, _changed in ranked[: args.max_prs]:
        print(f"PR #{pr.number} {pr.head_ref}: {pr.title}  (expected tier={tier})")

        if dry_run:
            # In dry-run: still run verify but skip the merge API call
            print(f"  [dry-run] running verify pipeline for PR #{pr.number}...")
            try:
                ok, detail = test_pr_in_worktree(
                    pr,
                    args.branch,
                    args.verify_timeout,
                    base_sha=base_sha,
                )
            except Exception as exc:
                print(f"  [dry-run] test raised {exc}")
                skipped += 1
                continue

            if ok:
                print(
                    f"  [dry-run] PR #{pr.number} would be merged (verify=GREEN); skipping merge API"
                )
                merged += 1  # count as "would merge"
            else:
                reason = (
                    "merge-conflict"
                    if detail.startswith("merge-conflict")
                    else "verify-failed"
                )
                print(f"  [dry-run] PR #{pr.number} would be rejected: {reason}")
                print(f"  detail: {detail[:500]}")
                rejected += 1
            continue

        # ── per-PR rate limit ─────────────────────────────────────────────────
        if check_pr_rate_limit(pr.number):
            cached += 1
            continue

        # If we already rejected this exact head SHA, skip re-running verify
        prior = already_rejected_at_sha(host, token, repo, pr.number, pr.head_sha)
        if prior:
            print(
                f"  [cached-skip] already rejected at {pr.head_sha[:12]} ({prior}); waiting for new push"
            )
            cached += 1
            continue

        try:
            deps = list_pr_dependencies(host, token, repo, pr.number)
        except Exception as exc:
            print(f"  [warn] could not check deps for PR #{pr.number}: {exc}")
            deps = []
        open_deps = [d for d in deps if str(d.get("state")) == "open"]
        if open_deps:
            numbers = ", ".join(f"#{d['number']}" for d in open_deps)
            print(
                f"  [dep-blocked] waiting on open dependency: {numbers}; skipping cycle"
            )
            skipped += 1
            continue

        try:
            ok, detail = test_pr_in_worktree(
                pr,
                args.branch,
                args.verify_timeout,
                base_sha=base_sha,
            )
        except Exception as exc:
            print(f"  [skip] test raised {exc}")
            skipped += 1
            continue

        # Charge the rate-limit counter after verify completes
        record_pr_attempt(pr.number)

        if not ok:
            reason = (
                "merge-conflict"
                if detail.startswith("merge-conflict")
                else "verify-failed"
            )
            body = textwrap.dedent(f"""\
                Auto-integrator rejected this PR.

                Reason: `{reason}` (tested against `{args.branch}`)

                ```text
                {detail}
                ```
                """).strip()
            try:
                comment_once_for_sha(
                    host, token, repo, pr.number, reason, pr.head_sha, body
                )
            except Exception as exc:
                print(f"  [warn] could not post comment: {exc}")
            rejected += 1
            continue

        # Force-push race guard
        fresh = get_pr(host, token, repo, pr.number)
        fresh_sha = str((fresh.get("head") or {}).get("sha") or "")
        if fresh_sha and fresh_sha != pr.head_sha:
            print(
                f"  [skip] PR #{pr.number} head moved {pr.head_sha[:12]}→{fresh_sha[:12]} "
                f"during verify; refusing to merge untested commit"
            )
            skipped += 1
            continue

        try:
            merge_pr_with_retry(host, token, repo, pr.number, args.merge_style)
        except RuntimeError as exc:
            if _is_transient_merge_error(exc):
                print(
                    f"  [skip] merge API returned transient lock error after all retries; "
                    f"rate-limit counter NOT charged: {exc}"
                )
            else:
                print(f"  [skip] merge API failed: {exc}")
            skipped += 1
            continue

        info = get_pr(host, token, repo, pr.number)
        if not info.get("merged"):
            print(
                f"  [warn] PR #{pr.number} not marked merged after API call; skipping"
            )
            skipped += 1
            continue

        merge_sha = info.get("merge_commit_sha") or ""
        merged += 1
        print(f"  merged at {merge_sha[:12]}")
        record_merge_timestamp()
        _write_reload_pending(merge_sha)

    if dry_run:
        print(
            f"[dry-run] would-merge={merged} would-reject={rejected} skipped={skipped}"
        )
    else:
        print(f"merged={merged} rejected={rejected} cached={cached} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
