from pathlib import Path

def test_launch_repair_worker_version_is_present():
    source=(Path(__file__).parent/'handler.py').read_text()
    assert 'BUNDLE_VERSION="2026-08-29-mcs-launch-repair"' in source
