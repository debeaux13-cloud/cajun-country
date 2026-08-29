from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runway_adapter import GEN4_TURBO_PORTRAIT_RATIO, GEN4_TURBO_SUPPORTED_RATIOS

def test_gen4_turbo_portrait_ratio_is_provider_supported():
    assert GEN4_TURBO_PORTRAIT_RATIO == '832:1104'
    assert GEN4_TURBO_PORTRAIT_RATIO in GEN4_TURBO_SUPPORTED_RATIOS
