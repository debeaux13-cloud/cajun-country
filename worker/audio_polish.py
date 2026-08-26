from __future__ import annotations

import os
import subprocess
from pathlib import Path

try:
    import requests
except ImportError:  # Provider-free local tests do not need the HTTP client.
    requests = None


ELEVENLABS_SFX_ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation'
DEFAULT_VIBE = 'surprise me'
SUPPORTED_VIBES = {
    DEFAULT_VIBE,
    'funny',
    'magical',
    'adventure',
    'heartwarming',
    'mystery',
    'kid-safe spooky',
}

_VIBE_PROMPTS = {
    'surprise me': 'bright cinematic wonder with warm piano, playful woodwinds, gentle strings, and a small feeling of discovery',
    'funny': 'playful comedy with pizzicato strings, marimba, bassoon, and tiny soft percussion accents',
    'magical': 'sparkling child-friendly magic with celesta, harp, airy pads, and warm sweeping strings',
    'adventure': 'buoyant family adventure with rhythmic strings, soft hand percussion, woodwinds, and restrained brass',
    'heartwarming': 'tender family warmth with felt piano, acoustic guitar, soft strings, and a reassuring melody',
    'mystery': 'curious child-friendly mystery with plucked strings, marimba, clarinet, and gentle suspended harmony',
    'kid-safe spooky': 'whimsical kid-safe spookiness with celesta, pizzicato strings, bassoon, and playful minor-key curiosity',
}

# A deterministic, provider-free safety bed for every supported vibe.  The
# frequencies form simple, distinct chords and are intentionally understated;
# this path is used only when music generation is unavailable.
_LOCAL_PROFILES = {
    'surprise me': ((261.63, 329.63, 392.00), 0.42),
    'funny': ((293.66, 369.99, 440.00), 3.20),
    'magical': ((523.25, 659.25, 783.99), 0.70),
    'adventure': ((196.00, 246.94, 293.66), 1.35),
    'heartwarming': ((220.00, 277.18, 329.63), 0.28),
    'mystery': ((220.00, 261.63, 329.63), 0.82),
    'kid-safe spooky': ((196.00, 233.08, 293.66), 1.05),
}


def normalize_music_vibe(value: object) -> str:
    vibe = str(value or '').strip().lower()
    return vibe if vibe in SUPPORTED_VIBES else DEFAULT_VIBE


def music_bed_prompt(vibe: object) -> str:
    selected = normalize_music_vibe(vibe)
    return (
        f"Seamless loopable instrumental underscore for a stylized animated family story: "
        f"{_VIBE_PROMPTS[selected]}. Keep the arrangement simple, melodic, and unobtrusive "
        "beneath narration and natural sound effects. No vocals, speech, chanting, lyrics, "
        "trailer hits, harsh impacts, frightening horror, or heavy percussion."
    )


def _local_music_bed(destination: str, duration: float, vibe: object) -> str:
    selected = normalize_music_vibe(vibe)
    frequencies, pulse = _LOCAL_PROFILES[selected]
    command = ['ffmpeg', '-y']
    for frequency in frequencies:
        command += ['-f', 'lavfi', '-i', f'sine=frequency={frequency}:sample_rate=44100']
    command += [
        '-filter_complex',
        (
            f'[0:a]volume=0.030,tremolo=f={pulse}:d=0.12[a0];'
            f'[1:a]volume=0.022,tremolo=f={pulse}:d=0.10[a1];'
            f'[2:a]volume=0.018,tremolo=f={pulse}:d=0.08[a2];'
            '[a0][a1][a2]amix=inputs=3:normalize=0,'
            'lowpass=f=1800,afade=t=in:st=0:d=1.5[a]'
        ),
        '-map', '[a]', '-t', str(duration), '-codec:a', 'libmp3lame', '-b:a', '96k', destination,
    ]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return destination


def create_background_music(
    destination: str,
    vibe: object = DEFAULT_VIBE,
    duration: float = 30.0,
    *,
    allow_provider: bool = True,
) -> str:
    """Create the raw, reusable music stem; never mix it into a movie here."""
    duration = max(10.0, min(30.0, float(duration)))
    selected = normalize_music_vibe(vibe)
    key = os.environ.get('ELEVENLABS_API_KEY', '').strip()
    if allow_provider and key and requests is not None:
        try:
            response = requests.post(
                ELEVENLABS_SFX_ENDPOINT,
                headers={'xi-api-key': key, 'Content-Type': 'application/json'},
                params={'output_format': 'mp3_44100_128'},
                json={
                    'text': music_bed_prompt(selected),
                    'duration_seconds': duration,
                    'prompt_influence': 0.35,
                    'model_id': 'eleven_text_to_sound_v2',
                },
                timeout=180,
            )
            if response.ok and len(response.content) > 10000:
                Path(destination).write_bytes(response.content)
                return destination
        except Exception:
            pass
    return _local_music_bed(destination, duration, selected)


def add_background_music(
    movie_path: str,
    workdir: str,
    target_seconds: int,
    *,
    music_path: str | None = None,
    vibe: object = DEFAULT_VIBE,
    allow_provider: bool = True,
) -> str:
    """Mix a quiet stem without changing it, preserving preview/paid continuity.

    When ``music_path`` is supplied, it is the authoritative preview stem and no
    provider is called.  Preview and paid mixes share the same source position,
    volume, and fade-in.  Only a movie longer than the 60-second preview receives
    a final fade-out, so its first minute remains identical to the preview mix.
    """
    music = str(music_path or (Path(workdir) / 'mcs-background-music.mp3'))
    if not music_path:
        create_background_music(music, vibe, 30, allow_provider=allow_provider)
    if not Path(music).is_file() or Path(music).stat().st_size < 1024:
        raise RuntimeError('Background music stem is missing or incomplete')
    polished = str(Path(workdir) / (Path(movie_path).stem + '-polished.mp4'))
    final_fade = f',afade=t=out:st={max(0, target_seconds - 3)}:d=3' if target_seconds > 60 else ''
    subprocess.run([
        'ffmpeg', '-y', '-i', movie_path, '-stream_loop', '-1', '-i', music,
        '-filter_complex',
        (
            '[0:a]volume=1.0[main];'
            f'[1:a]volume=0.055,afade=t=in:st=0:d=2{final_fade},'
            f'atrim=duration={target_seconds}[music];'
            '[main][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]'
        ),
        '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac',
        '-t', str(target_seconds), '-movflags', '+faststart', polished,
    ], check=True, timeout=1200, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    Path(movie_path).write_bytes(Path(polished).read_bytes())
    return movie_path
