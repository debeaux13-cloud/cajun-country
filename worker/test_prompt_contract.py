"""Provider-free regression tests for the bounded multi-subject still prompt."""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))
if "requests" not in sys.modules:
    try:
        import requests  # noqa: F401
    except ModuleNotFoundError:
        sys.modules["requests"] = types.ModuleType("requests")

from pipeline_steps import canonical_character_prompt, locked_still_prompt  # noqa: E402


class LockedStillPromptTest(unittest.TestCase):
    def test_character_master_keeps_twelve_subject_ids_inside_runway_limit(self):
        details = " | ".join(f"S{index}=subject-{index}-marker" for index in range(1, 13))
        identity = (
            f"PHOTO SCENE IDS (12/12): {details}. Keep IDs exact and distinct. "
            "Preserve each subject's anatomy, face, natural color, markings, clothing, and relative size."
        )
        prompt = canonical_character_prompt(identity)
        self.assertLessEqual(len(prompt), 1000)
        self.assertIn("S1=subject-1-marker", prompt)
        self.assertIn("S12=subject-12-marker", prompt)

    def test_keeps_all_twelve_scene_ids_inside_runway_limit(self):
        details = " | ".join(f"S{index}=subject-{index}-marker" for index in range(1, 13))
        identity = (
            f"PHOTO SCENE IDS (12/12): {details}. Only these upload IDs appear; others stay off-screen. "
            "Keep IDs exact/distinct. No merge, swap, hybrid, duplicate, or trait transfer."
        )
        self.assertLessEqual(len(identity), 500)
        scene = {
            "identityLock": identity,
            "setting": "a moonlit carnival beside a sparkling lake with striped tents",
            "visibleAction": "all twelve friends sprint together, leap a ribbon, and catch a glowing frisbee",
            "requiredVisibleDetails": ["silver moon", "striped tents", "glowing frisbee", "sparkling lake"],
            "supportingCharacters": ["one friendly fairy announcer"],
        }
        prompt = locked_still_prompt(scene)
        self.assertLessEqual(len(prompt), 1000)
        self.assertIn(identity, prompt)
        self.assertIn("S1=subject-1-marker", prompt)
        self.assertIn("S12=subject-12-marker", prompt)


if __name__ == "__main__":
    unittest.main()
