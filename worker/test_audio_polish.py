"""Provider-free regression tests for vibe music and preview continuity."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


WORKER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKER_DIR))

import audio_polish  # noqa: E402


def _run(command: list[str]) -> bytes:
    return subprocess.run(command, check=True, capture_output=True, timeout=1200).stdout


def _silent_movie(path: Path, seconds: int) -> None:
    _run([
        'ffmpeg', '-y',
        '-f', 'lavfi', '-i', f'color=c=black:s=64x64:r=30:d={seconds}',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', str(seconds), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-movflags', '+faststart', str(path),
    ])


def _first_minute_pcm(path: Path) -> bytes:
    return _run([
        'ffmpeg', '-v', 'error', '-i', str(path), '-t', '59', '-vn',
        '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ])


@unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg is required')
class VibeMusicContinuityTest(unittest.TestCase):
    def test_provider_free_mode_never_calls_music_provider(self) -> None:
        with tempfile.TemporaryDirectory(prefix='mcs-music-local-') as folder:
            destination = Path(folder) / 'funny.mp3'
            provider = mock.Mock()
            with mock.patch.object(audio_polish, 'requests', provider), mock.patch.dict(os.environ, {'ELEVENLABS_API_KEY': 'must-not-be-used'}):
                audio_polish.create_background_music(str(destination), 'funny', 10, allow_provider=False)
            provider.post.assert_not_called()
            self.assertGreater(destination.stat().st_size, 20 * 1024)

    def test_every_vibe_has_a_distinct_music_direction(self) -> None:
        prompts = {audio_polish.music_bed_prompt(vibe) for vibe in audio_polish.SUPPORTED_VIBES}
        self.assertEqual(len(prompts), len(audio_polish.SUPPORTED_VIBES))
        for prompt in prompts:
            self.assertIn('No vocals', prompt)

    def test_paid_movie_reuses_the_unchanged_preview_stem_from_zero(self) -> None:
        with tempfile.TemporaryDirectory(prefix='mcs-music-continuity-') as folder:
            root = Path(folder)
            stem = root / 'music-bed.mp3'
            preview = root / 'preview.mp4'
            paid = root / 'paid.mp4'
            audio_polish.create_background_music(str(stem), 'magical', 10, allow_provider=False)
            original_hash = hashlib.sha256(stem.read_bytes()).hexdigest()
            _silent_movie(preview, 60)
            _silent_movie(paid, 180)

            audio_polish.add_background_music(str(preview), str(root), 60, music_path=str(stem), vibe='magical')
            audio_polish.add_background_music(str(paid), str(root), 180, music_path=str(stem), vibe='magical')

            self.assertEqual(hashlib.sha256(stem.read_bytes()).hexdigest(), original_hash)
            self.assertEqual(_first_minute_pcm(preview), _first_minute_pcm(paid))


    def test_all_canonical_moods_survive_normalization(self) -> None:
        for vibe in ('surprise me', 'funny', 'silly', 'dramatic', 'spooky', 'romantic'):
            self.assertEqual(audio_polish.normalize_music_vibe(vibe), vibe)


if __name__ == '__main__':
    unittest.main()
