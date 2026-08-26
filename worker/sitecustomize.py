"""Runtime patches loaded automatically before the RunPod handler."""
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
    pass

try:
    import runway_adapter
    import pipeline_steps as _pipeline_steps

    _original_animate = runway_adapter.RunwayGen4Turbo.animate

    def _animate_with_motion_retry(self, source, destination, prompt, *, existing_task_id=None, on_task_created=None):
        result = _original_animate(
            self,
            source,
            destination,
            prompt,
            existing_task_id=existing_task_id,
            on_task_created=on_task_created,
        )
        try:
            _pipeline_steps.verify_obvious_clip_motion(destination)
            return result
        except Exception as first_error:
            # One intentional quality rerender is allowed after a provider task
            # succeeds but the principal character remains too static. Never
            # loop indefinitely and never reuse the first completed task id.
            stronger = (
                "STRONG PRINCIPAL CHARACTER MOTION REQUIRED. The main character must visibly travel across the frame and physically perform the narrated action from beginning to completion. "
                "Show clear limb, paw, head, torso, and body-position changes every few seconds; include weight shifts, blinking, breathing, expression changes, and direct interaction with the named prop or environment. "
                "Camera and scenery movement are secondary and may not substitute for body movement. No frozen pose, no hovering, no pan-only or zoom-only shot. "
                + str(prompt or "")
            )
            if on_task_created:
                try:
                    on_task_created("motion-quality-rerender", retryAttempt=1, priorFailureCode="MCS.MOTION_GATE", priorFailure=str(first_error)[:300])
                except Exception:
                    pass
            retry_result = _original_animate(
                self,
                source,
                destination,
                stronger,
                existing_task_id=None,
                on_task_created=on_task_created,
            )
            _pipeline_steps.verify_obvious_clip_motion(destination)
            return retry_result

    runway_adapter.RunwayGen4Turbo.animate = _animate_with_motion_retry
except Exception:
    # A missing optional runtime patch must never prevent the worker from booting.
    pass
