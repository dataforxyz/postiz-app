"""Integration tests for scripts/reload_on_merge.sh.

These tests verify structure and no-op behaviour without touching any live
service. They do NOT test the full restart/smoke path — that requires a
running postiz instance and is validated in CI end-to-end flows.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "reload_on_merge.sh"


def test_script_exists():
    """The reload_on_merge.sh script must be present in scripts/."""
    assert SCRIPT.exists(), f"Expected {SCRIPT} to exist"


def test_script_is_executable():
    """The script must be executable (cron invokes it directly)."""
    assert os.access(SCRIPT, os.X_OK), f"{SCRIPT} is not executable"


def test_no_flag_exits_zero(tmp_path):
    """With no flag file present the script must exit 0 immediately (no-op)."""
    env = os.environ.copy()
    # Point FLAG env at a path that does not exist.
    flag = tmp_path / "postiz-app-integrator-reload-pending"
    assert not flag.exists()

    result = subprocess.run(
        ["bash", str(SCRIPT)],
        env={**env, "FLAG": str(flag)},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, (
        f"Expected exit 0 with no flag; got {result.returncode}\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_script_has_shebang():
    """Script must start with a bash shebang so it can be invoked directly."""
    first_line = SCRIPT.read_text().splitlines()[0]
    assert first_line.startswith("#!/"), f"Missing shebang; got: {first_line!r}"
    assert "bash" in first_line, f"Expected bash shebang; got: {first_line!r}"


def test_script_contains_flock_fd_close():
    """The FD-close trick (3<&- ... 9<&-) must be present to prevent lock leaks."""
    content = SCRIPT.read_text()
    assert "3<&-" in content, "Missing FD-close trick (3<&-) in reload_on_merge.sh"


def test_script_references_auto_revert():
    """Auto-revert path (git revert) must be present as the safety net."""
    content = SCRIPT.read_text()
    assert "git" in content and "revert" in content, (
        "Auto-revert path (git revert) missing from reload_on_merge.sh"
    )


def test_script_references_postiz_restart():
    """Script must invoke make postiz-restart from the juston-app directory."""
    content = SCRIPT.read_text()
    assert "postiz-restart" in content, (
        "make postiz-restart not referenced in reload_on_merge.sh"
    )


def test_script_references_pnpm_build():
    """Script must run pnpm build before restarting."""
    content = SCRIPT.read_text()
    assert "pnpm build" in content, "pnpm build step missing from reload_on_merge.sh"
