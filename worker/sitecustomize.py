"""Runtime patch loaded automatically by Python before the RunPod handler."""
try:
    import pipeline_steps
    from audio_polish import add_background_music

    _original_build_movie = pipeline_steps.build_movie

    def _mcs_build_movie(video_paths, audio_paths, workdir, destination, target_seconds=pipeline_steps.MOVIE_SECONDS, sound_effect_paths=None):
        result = _original_build_movie(
            video_paths,
            audio_paths,
            workdir,
            destination,
            target_seconds,
            sound_effect_paths=sound_effect_paths,
        )
        return add_background_music(result, workdir, int(target_seconds))

    pipeline_steps.build_movie = _mcs_build_movie
except Exception:
    # Audio polish is additive. Never prevent a worker from booting if the
    # optional music layer itself cannot initialize.
    pass
