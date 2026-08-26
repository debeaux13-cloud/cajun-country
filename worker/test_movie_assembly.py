"""Local, provider-free regression coverage for MCS movie assembly."""
from __future__ import annotations

import json
import hashlib
import math
import shutil
import subprocess
import sys
import tempfile
import unittest
from array import array
from pathlib import Path


WORKER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKER_DIR))

from audio_polish import add_background_music, create_background_music  # noqa: E402
from pipeline_steps import build_movie, verify_movie  # noqa: E402


def _run(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=True, capture_output=True, timeout=1200)


def _duration(path: Path, *, stream: str | None = None) -> float:
    command = ["ffprobe", "-v", "error"]
    if stream:
        command += ["-select_streams", stream]
    command += [
        "-show_entries",
        "stream=duration" if stream else "format=duration",
        "-of",
        "json",
        str(path),
    ]
    payload = json.loads(_run(command).stdout)
    if stream:
        return float(payload["streams"][0]["duration"])
    return float(payload["format"]["duration"])


def _high_frequency_rms(path: Path, start: float, duration: float) -> float:
    pcm = _run([
        "ffmpeg", "-v", "error", "-ss", str(start), "-i", str(path),
        "-t", str(duration), "-af", "highpass=f=2500", "-ac", "1", "-ar", "16000",
        "-f", "s16le", "pipe:1",
    ]).stdout
    samples = array("h")
    samples.frombytes(pcm)
    if not samples:
        return 0.0
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def _audio_packet_dts(path: Path) -> list[float]:
    payload = json.loads(_run([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets",
        "-show_entries", "packet=dts_time", "-of", "json", str(path),
    ]).stdout)
    return [float(packet["dts_time"]) for packet in payload.get("packets", []) if "dts_time" in packet]


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class MovieAssemblyTimingTest(unittest.TestCase):
    def _make_inputs(self, root: Path) -> tuple[Path, Path, Path, Path]:
        ordinary = root / "ordinary.mp4"
        ending = root / "ending-marker.mp4"
        narration = root / "narration.wav"
        sound_effect = root / "sound-effect.wav"

        _run([
            "ffmpeg", "-y", "-f", "lavfi", "-i",
            "color=c=0x182030:s=320x180:r=30:d=1",
            "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(ordinary),
        ])
        _run([
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=c=0x182030:s=320x180:r=30:d=0.8",
            "-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=0.2",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map", "[v]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(ending),
        ])
        _run([
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=10.8",
            "-f", "lavfi", "-i", "sine=frequency=3000:sample_rate=44100:duration=0.4",
            "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
            "-map", "[a]", "-c:a", "pcm_s16le", str(narration),
        ])
        _run([
            "ffmpeg", "-y", "-f", "lavfi", "-i",
            "sine=frequency=220:sample_rate=44100:duration=0.4",
            "-c:a", "pcm_s16le", str(sound_effect),
        ])
        return ordinary, ending, narration, sound_effect

    def _assert_contract(self, scene_count: int, target_seconds: int) -> None:
        with tempfile.TemporaryDirectory(prefix=f"mcs-assembly-{scene_count}-") as folder:
            root = Path(folder)
            ordinary, ending, narration, sound_effect = self._make_inputs(root)
            videos = [str(ordinary)] * (scene_count - 1) + [str(ending)]
            narrations = [str(narration)] * scene_count
            effects = [str(sound_effect)] * scene_count
            movie = root / "movie.mp4"

            build_movie(
                videos,
                narrations,
                str(root),
                str(movie),
                target_seconds,
                sound_effect_paths=effects,
            )
            self.assertAlmostEqual(_duration(movie), target_seconds, delta=0.08)
            assembled_dts = _audio_packet_dts(movie)
            self.assertGreater(len(assembled_dts), 2)
            # Normal AAC packets are ~23 ms apart at 44.1 kHz.  The old stream
            # copy produced one-tick DTS corrections at every scene boundary.
            self.assertGreater(min(b - a for a, b in zip(assembled_dts, assembled_dts[1:])), 0.01)
            # Match the production handler: music is added once after the
            # narration/SFX movie is assembled.  The provider-free stem is
            # supplied explicitly, just like the stored preview asset is on a
            # paid continuation; mixing must never mutate that reusable stem.
            music = root / "preview-music-bed.mp3"
            create_background_music(str(music), "magical", 10, allow_provider=False)
            music_hash = hashlib.sha256(music.read_bytes()).hexdigest()
            add_background_music(str(movie), str(root), target_seconds, music_path=str(music), vibe="magical")
            self.assertEqual(hashlib.sha256(music.read_bytes()).hexdigest(), music_hash)

            verify_movie(str(movie), target_seconds)
            self.assertAlmostEqual(_duration(movie), target_seconds, delta=0.08)
            self.assertAlmostEqual(_duration(movie, stream="v:0"), target_seconds, delta=0.08)
            self.assertAlmostEqual(_duration(movie, stream="a:0"), target_seconds, delta=0.08)

            expected_scene_seconds = target_seconds / scene_count
            for index in range(1, scene_count + 1):
                self.assertAlmostEqual(
                    _duration(root / f"segment-{index}.mp4"),
                    expected_scene_seconds,
                    delta=0.08,
                )

            # The source's white ending marker occupies its final 20%.  It was
            # absent when `-t` chopped 2.5s from preview scene 6 and 8.5s from
            # paid scene 18.  Seeing it just before the target proves the last
            # scene's ending survived assembly.
            pixel = _run([
                "ffmpeg", "-v", "error", "-ss", str(target_seconds - 0.25),
                "-i", str(movie), "-frames:v", "1", "-vf", "scale=1:1",
                "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
            ]).stdout
            self.assertEqual(len(pixel), 3)
            self.assertGreater(min(pixel), 225)

            # Narration is deliberately 11.2 seconds long and ends with a
            # 3 kHz marker.  Assembly must tempo-fit that full recording into
            # the scene; the former atrim-only behavior silently removed it.
            self.assertGreater(
                _high_frequency_rms(movie, target_seconds - 0.45, 0.25),
                250.0,
            )

    def test_six_scene_preview_is_complete_and_exactly_60_seconds(self) -> None:
        self._assert_contract(scene_count=6, target_seconds=60)

    def test_eighteen_scene_paid_movie_is_complete_and_exactly_180_seconds(self) -> None:
        self._assert_contract(scene_count=18, target_seconds=180)

    def test_narration_that_cannot_stay_intelligible_fails_instead_of_clipping(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mcs-assembly-too-long-") as folder:
            root = Path(folder)
            ordinary, _, _, _ = self._make_inputs(root)
            narration = root / "too-long.wav"
            _run([
                "ffmpeg", "-y", "-f", "lavfi", "-i",
                "sine=frequency=440:sample_rate=44100:duration=16",
                "-c:a", "pcm_s16le", str(narration),
            ])
            with self.assertRaisesRegex(RuntimeError, "assembly stopped instead of cutting off words"):
                build_movie([str(ordinary)], [str(narration)], str(root), str(root / "movie.mp4"), 10)


if __name__ == "__main__":
    unittest.main()
