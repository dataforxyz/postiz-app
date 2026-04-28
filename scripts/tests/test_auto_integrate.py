"""Unit tests for scripts/auto_integrate_dev_prs.py (postiz-app port).

Covers:
- Baseline cache: hit (skip verify), miss on SHA change, miss on TTL expiry,
  miss on pnpm-lock.yaml hash change.
- Per-PR cache: hit vs miss on PR head SHA / base SHA change, TTL expiry.
- Loop-guard: self-webhook detection (INTEGRATOR_TRIGGER=webhook + SHA check).
- Cycle limiter: at-cap, above-cap, under-cap, stale entries ignored.
- Queue-empty fast exit: zero-open-PRs path exits 0 without baseline verify.
- Fail-open: corrupt cache file → re-verify + rewrite.
- Sentinel parsing: already_rejected_at_sha detects prior rejection comment.

None of these tests run the actual pnpm pipeline. All subprocess calls are
mocked/monkeypatched.
"""

from __future__ import annotations

import datetime
import importlib
import importlib.util
import json
import os
import sys
import types
from pathlib import Path
from unittest import mock

import pytest

# ---------------------------------------------------------------------------
# Load the integrator script as a module (not __main__) so we can call
# functions directly without executing main().
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "auto_integrate_dev_prs.py"


def _load_integrator() -> types.ModuleType:
    """Import auto_integrate_dev_prs as a fresh module for each test."""
    mod_name = f"_auto_integrate_{id(object())}"
    spec = importlib.util.spec_from_file_location(mod_name, _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(mod_name, None)
    return mod


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso_ago(seconds: int) -> str:
    dt = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# 1. Baseline cache
# ---------------------------------------------------------------------------


class TestBaselineCache:
    """load_baseline_cache / save_baseline_cache round-trips and invalidation."""

    def test_hit_returns_entry(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"

        sha = "abc123def456abc123def456abc123def456abc1"
        lock_hash = mod._pnpm_lock_hash()

        entry = {
            sha: {
                "sha": sha,
                "verified_at_iso": _iso_ago(60),
                "result": "green",
                "pnpm_lock_hash": lock_hash,
            }
        }
        mod._BASELINE_CACHE_FILE.write_text(json.dumps(entry))

        result = mod.load_baseline_cache(sha)
        assert result is not None
        assert result["result"] == "green"

    def test_miss_on_sha_change(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"

        sha = "abc123def456abc123def456abc123def456abc1"
        other_sha = "f" * 40
        lock_hash = mod._pnpm_lock_hash()
        entry = {
            sha: {
                "sha": sha,
                "verified_at_iso": _iso_ago(60),
                "result": "green",
                "pnpm_lock_hash": lock_hash,
            }
        }
        mod._BASELINE_CACHE_FILE.write_text(json.dumps(entry))

        result = mod.load_baseline_cache(other_sha)
        assert result is None

    def test_miss_on_ttl_expiry_green(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"
        mod._BASELINE_GREEN_TTL = 10  # shrink TTL for test

        sha = "abc123def456abc123def456abc123def456abc1"
        lock_hash = mod._pnpm_lock_hash()
        entry = {
            sha: {
                "sha": sha,
                "verified_at_iso": _iso_ago(20),  # 20s > 10s TTL
                "result": "green",
                "pnpm_lock_hash": lock_hash,
            }
        }
        mod._BASELINE_CACHE_FILE.write_text(json.dumps(entry))

        result = mod.load_baseline_cache(sha)
        assert result is None

    def test_miss_on_pnpm_lock_hash_change(self, tmp_path):
        """Cache entry invalid if pnpm-lock.yaml/package.json hash changed."""
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"

        sha = "abc123def456abc123def456abc123def456abc1"
        entry = {
            sha: {
                "sha": sha,
                "verified_at_iso": _iso_ago(60),
                "result": "green",
                "pnpm_lock_hash": "stale-hash-will-not-match",
            }
        }
        mod._BASELINE_CACHE_FILE.write_text(json.dumps(entry))

        result = mod.load_baseline_cache(sha)
        assert result is None

    def test_red_cache_uses_shorter_ttl(self, tmp_path):
        """A red cache entry expires after _BASELINE_RED_TTL, not green TTL."""
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"
        mod._BASELINE_RED_TTL = 10
        mod._BASELINE_GREEN_TTL = 3600

        sha = "abc123def456abc123def456abc123def456abc1"
        lock_hash = mod._pnpm_lock_hash()
        entry = {
            sha: {
                "sha": sha,
                "verified_at_iso": _iso_ago(20),  # 20s > 10s red TTL
                "result": "red",
                "pnpm_lock_hash": lock_hash,
            }
        }
        mod._BASELINE_CACHE_FILE.write_text(json.dumps(entry))

        result = mod.load_baseline_cache(sha)
        assert result is None

    def test_red_clear_override_busts_cache(self, tmp_path):
        """/tmp/postiz-app-integrator-baseline-red-clear override busts cache."""
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"

        sha = "abc123def456abc123def456abc123def456abc1"
        lock_hash = mod._pnpm_lock_hash()
        entry = {
            sha: {
                "sha": sha,
                "verified_at_iso": _iso_ago(60),
                "result": "green",
                "pnpm_lock_hash": lock_hash,
            }
        }
        mod._BASELINE_CACHE_FILE.write_text(json.dumps(entry))

        clear_path = tmp_path / "baseline-red-clear"
        clear_path.touch()
        mod._BASELINE_RED_CLEAR = clear_path
        mod._BASELINE_RED_UNTIL = tmp_path / "baseline-red-until"

        result = mod.load_baseline_cache(sha)
        assert result is None


# ---------------------------------------------------------------------------
# 2. Per-PR cache
# ---------------------------------------------------------------------------


class TestPRCache:
    """load_pr_cache / save_pr_cache hit/miss scenarios."""

    def test_hit_matching_head_and_base(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._PR_CACHE_FILE = tmp_path / "pr_verify.json"

        pr_num = 42
        head_sha = "a" * 40
        base_sha = "b" * 40

        data = {
            "42": {
                "head_sha": head_sha,
                "base_sha": base_sha,
                "verified_at_iso": _iso_ago(60),
                "result": "green",
            }
        }
        mod._PR_CACHE_FILE.write_text(json.dumps(data))

        result = mod.load_pr_cache(pr_num, head_sha, base_sha)
        assert result is not None
        assert result["result"] == "green"

    def test_miss_on_head_sha_change(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._PR_CACHE_FILE = tmp_path / "pr_verify.json"

        data = {
            "42": {
                "head_sha": "old-head",
                "base_sha": "b" * 40,
                "verified_at_iso": _iso_ago(60),
                "result": "green",
            }
        }
        mod._PR_CACHE_FILE.write_text(json.dumps(data))

        result = mod.load_pr_cache(42, "new-head", "b" * 40)
        assert result is None

    def test_miss_on_base_sha_change(self, tmp_path):
        """If the integration branch advanced, invalidate PR cache."""
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._PR_CACHE_FILE = tmp_path / "pr_verify.json"

        data = {
            "42": {
                "head_sha": "a" * 40,
                "base_sha": "old-base",
                "verified_at_iso": _iso_ago(60),
                "result": "green",
            }
        }
        mod._PR_CACHE_FILE.write_text(json.dumps(data))

        result = mod.load_pr_cache(42, "a" * 40, "new-base")
        assert result is None

    def test_miss_on_ttl_expiry(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._PR_CACHE_FILE = tmp_path / "pr_verify.json"
        mod._PR_GREEN_TTL = 5

        data = {
            "42": {
                "head_sha": "a" * 40,
                "base_sha": "b" * 40,
                "verified_at_iso": _iso_ago(10),  # 10s > 5s TTL
                "result": "green",
            }
        }
        mod._PR_CACHE_FILE.write_text(json.dumps(data))

        result = mod.load_pr_cache(42, "a" * 40, "b" * 40)
        assert result is None

    def test_red_result_not_saved(self, tmp_path):
        """Red PR results must not be written to the cache."""
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._PR_CACHE_FILE = tmp_path / "pr_verify.json"

        mod.save_pr_cache(42, "a" * 40, "b" * 40, "red")

        data = mod._load_json_cache(mod._PR_CACHE_FILE)
        assert "42" not in data


# ---------------------------------------------------------------------------
# 3. Fail-open: corrupt cache → treated as miss
# ---------------------------------------------------------------------------


class TestFailOpen:
    """Corrupt cache files must not cause a crash; they should re-verify."""

    def test_corrupt_baseline_cache_returns_none(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"
        mod._BASELINE_CACHE_FILE.write_text("{ NOT VALID JSON <<<")

        result = mod.load_baseline_cache("any-sha")
        assert result is None

    def test_corrupt_pr_cache_returns_none(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._PR_CACHE_FILE = tmp_path / "pr_verify.json"
        mod._PR_CACHE_FILE.write_text("NOT JSON AT ALL")

        result = mod.load_pr_cache(42, "head", "base")
        assert result is None

    def test_save_baseline_cache_rewrites_after_corrupt(self, tmp_path):
        """After a corrupt read, save still works and produces valid JSON."""
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"
        mod._BASELINE_CACHE_FILE.write_text("GARBAGE")

        sha = "abc123def456abc123def456abc123def456abc1"
        mod.save_baseline_cache(sha, "green")

        data = json.loads(mod._BASELINE_CACHE_FILE.read_text())
        assert sha in data
        assert data[sha]["result"] == "green"


# ---------------------------------------------------------------------------
# 4. Loop-guard: self-webhook detection
# ---------------------------------------------------------------------------


class TestSelfWebhookTrigger:
    """is_self_webhook_trigger() must detect integrator-authored merges."""

    def _run(self, mod, env: dict, commit_body: str = "") -> bool:
        fake_result = mock.MagicMock()
        fake_result.stdout = commit_body

        def fake_run(cmd, **kwargs):
            return fake_result

        with (
            mock.patch.dict(os.environ, env, clear=False),
            mock.patch.object(mod, "run", fake_run),
        ):
            return mod.is_self_webhook_trigger()

    def test_marker_in_commit_skips(self):
        mod = _load_integrator()
        trailer = mod.INTEGRATOR_COMMIT_TRAILER
        result = self._run(
            mod,
            env={"INTEGRATOR_TRIGGER": "webhook", "INTEGRATOR_TRIGGER_SHA": "abc123"},
            commit_body=f"Merge branch 'feat/foo'\n\n{trailer}\n",
        )
        assert result is True

    def test_no_marker_proceeds(self):
        mod = _load_integrator()
        result = self._run(
            mod,
            env={"INTEGRATOR_TRIGGER": "webhook", "INTEGRATOR_TRIGGER_SHA": "def456"},
            commit_body="feat: add new thing\n\nSome description.",
        )
        assert result is False

    def test_cron_path_always_proceeds(self):
        mod = _load_integrator()
        result = self._run(
            mod,
            env={"INTEGRATOR_TRIGGER_SHA": "abc123"},
            commit_body=f"Merge\n\n{mod.INTEGRATOR_COMMIT_TRAILER}\n",
        )
        assert result is False

    def test_webhook_without_sha_warns_and_proceeds(self, capsys):
        mod = _load_integrator()
        env_copy = {k: v for k, v in os.environ.items() if k != "INTEGRATOR_TRIGGER_SHA"}
        env_copy["INTEGRATOR_TRIGGER"] = "webhook"

        with mock.patch.dict(os.environ, env_copy, clear=True):
            result = mod.is_self_webhook_trigger()

        assert result is False
        captured = capsys.readouterr()
        assert "INTEGRATOR_TRIGGER_SHA not set" in captured.out


# ---------------------------------------------------------------------------
# 5. Cycle limiter
# ---------------------------------------------------------------------------


class TestCycleLimit:
    """check_cycle_limit() must enforce the per-hour merge cap."""

    @pytest.fixture()
    def tmp_log(self, tmp_path):
        return tmp_path / "integrator_merges.log"

    def _write_timestamps(self, log: Path, count: int, minutes_ago: int = 0) -> None:
        log.parent.mkdir(parents=True, exist_ok=True)
        now = datetime.datetime.now(datetime.timezone.utc)
        offset = datetime.timedelta(minutes=minutes_ago)
        with log.open("w") as fh:
            for _ in range(count):
                ts = (now - offset).strftime("%Y-%m-%dT%H:%M:%SZ")
                fh.write(ts + "\n")

    def test_at_limit_aborts(self, tmp_log):
        mod = _load_integrator()
        cap = 5
        self._write_timestamps(tmp_log, cap, minutes_ago=1)
        with mock.patch.dict(os.environ, {"INTEGRATOR_MAX_MERGES_PER_HOUR": str(cap)}):
            result = mod.check_cycle_limit(merge_log=tmp_log)
        assert result is True

    def test_under_limit_proceeds(self, tmp_log):
        mod = _load_integrator()
        cap = 10
        self._write_timestamps(tmp_log, cap - 1, minutes_ago=2)
        with mock.patch.dict(os.environ, {"INTEGRATOR_MAX_MERGES_PER_HOUR": str(cap)}):
            result = mod.check_cycle_limit(merge_log=tmp_log)
        assert result is False

    def test_missing_log_file_is_fine(self, tmp_log):
        mod = _load_integrator()
        assert not tmp_log.exists()
        with mock.patch.dict(os.environ, {"INTEGRATOR_MAX_MERGES_PER_HOUR": "30"}):
            result = mod.check_cycle_limit(merge_log=tmp_log)
        assert result is False

    def test_stale_entries_ignored(self, tmp_log):
        mod = _load_integrator()
        cap = 3
        self._write_timestamps(tmp_log, cap, minutes_ago=70)
        with mock.patch.dict(os.environ, {"INTEGRATOR_MAX_MERGES_PER_HOUR": str(cap)}):
            result = mod.check_cycle_limit(merge_log=tmp_log)
        assert result is False

    def test_default_cap_is_30(self):
        mod = _load_integrator()
        assert mod._DEFAULT_MAX_MERGES_PER_HOUR == 30

    def test_record_merge_timestamp_appends(self, tmp_log):
        mod = _load_integrator()
        mod.record_merge_timestamp(merge_log=tmp_log)
        mod.record_merge_timestamp(merge_log=tmp_log)

        lines = [ln.strip() for ln in tmp_log.read_text().splitlines() if ln.strip()]
        assert len(lines) == 2
        for line in lines:
            dt = datetime.datetime.fromisoformat(line.replace("Z", "+00:00"))
            assert dt.tzinfo is not None


# ---------------------------------------------------------------------------
# 6. Queue-empty fast exit
# ---------------------------------------------------------------------------


class TestQueueEmptyFastExit:
    """When zero PRs are open, main() exits 0 without calling verify_baseline."""

    def _make_fake_api(self, mod, empty: bool):
        def fake_api(host, token, method, path, payload=None, *, retries=3):
            if "/pulls" in path and "state=open" in path:
                return (
                    []
                    if empty
                    else [
                        {
                            "number": 1,
                            "title": "test",
                            "head": {"ref": "feat/x", "sha": "abc123"},
                            "base": {"ref": "dev/all-open-prs-preview"},
                            "html_url": "https://example.com/pulls/1",
                            "draft": False,
                            "state": "open",
                        }
                    ]
                )
            if path.endswith("/user"):
                return {"login": "bot"}
            return {}

        return fake_api

    def test_zero_prs_exits_0_without_baseline(self, tmp_path):
        mod = _load_integrator()
        mod._CACHE_DIR = tmp_path
        mod._BASELINE_CACHE_FILE = tmp_path / "baseline_verify.json"

        baseline_called = []

        def fake_verify_baseline(*args, **kwargs):
            baseline_called.append(True)
            return True, ""

        fake_api = self._make_fake_api(mod, empty=True)

        with (
            mock.patch.object(mod, "api", side_effect=fake_api),
            mock.patch.object(mod, "verify_baseline", side_effect=fake_verify_baseline),
            mock.patch.object(mod, "infer_token", return_value="fake-token"),
            mock.patch.object(mod, "infer_repo", return_value=("fgit.example.com", "org/repo")),
            mock.patch.object(mod, "run", return_value=mock.MagicMock(stdout="sha1\n", returncode=0)),
            mock.patch.object(mod, "shell", return_value=mock.MagicMock(stdout="", stderr="", returncode=0)),
            mock.patch.object(mod, "ensure_clean_tree"),
            mock.patch.object(mod, "clean_stale_tmp_worktrees"),
            mock.patch.object(mod, "check_baseline_backoff", return_value=False),
            mock.patch.object(mod, "check_cycle_limit", return_value=False),
            mock.patch.object(mod, "is_self_webhook_trigger", return_value=False),
            mock.patch.object(mod, "_KILL_SWITCH", tmp_path / "no-kill-switch"),
            mock.patch("shutil.disk_usage", return_value=mock.MagicMock(free=1e10, total=1e11)),
        ):
            rc = mod.main(["--dry-run", "--branch", "dev/all-open-prs-preview"])

        assert rc == 0
        assert not baseline_called, "verify_baseline was called despite empty queue"


# ---------------------------------------------------------------------------
# 7. Sentinel comment parsing
# ---------------------------------------------------------------------------


class TestSentinelParsing:
    """already_rejected_at_sha detects prior rejection comments."""

    def test_finds_rejection_in_comments(self):
        mod = _load_integrator()
        head_sha = "cfa6dcf1ea37" + "0" * 28
        short = head_sha[:12]

        comment_body = (
            f"<!-- auto-integrator:verify-failed:{short} -->\n\n"
            "Auto-integrator rejected this PR.\n"
        )

        fake_comments = [{"body": comment_body}]

        with mock.patch.object(mod, "list_comments", return_value=fake_comments):
            reason = mod.already_rejected_at_sha(
                "fgit.example.com", "tok", "org/repo", 9, head_sha
            )

        assert reason == "verify-failed"

    def test_no_match_returns_none(self):
        mod = _load_integrator()
        head_sha = "aabbccddeeff" + "0" * 28

        fake_comments = [{"body": "Just a normal comment with no sentinel."}]

        with mock.patch.object(mod, "list_comments", return_value=fake_comments):
            reason = mod.already_rejected_at_sha(
                "fgit.example.com", "tok", "org/repo", 9, head_sha
            )

        assert reason is None


# ---------------------------------------------------------------------------
# 8. Timing context manager (smoke test)
# ---------------------------------------------------------------------------


class TestTimingContext:
    def test_timing_logs_duration(self, capsys):
        mod = _load_integrator()
        with mod.timing("test-stage"):
            pass
        captured = capsys.readouterr()
        assert "stage=test-stage" in captured.out
        assert "duration_ms=" in captured.out
