"""Resolve the citation ledger home for standalone skill scripts.

Modified for LULUX ETA (originally resolved HERMES_HOME): in LULUX the skill script
runs with the session workspace as its working directory (exported as
LULUX_WORKSPACE), so the ledger lives in <workspace>/.citations/.
The function name is kept so sources.py stays close to upstream.
"""

from __future__ import annotations

import os
from pathlib import Path


def get_hermes_home() -> Path:
    """Return the LULUX session workspace (falls back to the current directory)."""
    val = os.environ.get("LULUX_WORKSPACE", "").strip()
    return Path(val) if val else Path.cwd()
