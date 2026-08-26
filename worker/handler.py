"""RunPod queue worker for the complete two-tier Main Character Studios pipeline."""
from __future__ import annotations

import os
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
import runpod

from pipeline_steps import build_movie, build_pdf, build_sequence, illustrate, narrate, sound_effect, plan_preview_story, plan_story, validate_story_plan, validate_unique_scene_images, verify_movie, verify_obvious_clip_motion
from runway_adapter import RunwayGen4Turbo


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing worker setting: {name}")
    return value


def _headers(content_type: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {_required('MCS_WORKER_SECRET')}"}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def handler(event):
    payload = event.get("input") or event
    if payload.get("action") == "version":
        return {"status": "ready", "bundleVersion": "2026-08-23-sound-resume-v12"}
    supplied_worker_secret = str(payload.get("workerSecret") or "").strip()
    if supplied_worker_secret:
        os.environ["MCS_WORKER_SECRET"] = supplied_worker_secret
    job_id = str(payload.get("jobId") or "")
    mode = str(payload.get("mode") or "paid")
    callback_base = str(payload.get("callbackBase") or "").rstrip("/")
    if not job_id or not callback_base:
        raise ValueError("jobId and callbackBase are required")
    preview_mode = mode in {"preview", "preview_sound_resume"}
    job_url = f"{callback_base}/api/internal/preview-pipeline/{job_id}" if preview_mode else f"{callback_base}/api/internal/pipeline/jobs/{job_id}"
    job_response = requests.get(job_url, headers=_headers(), timeout=30)
    if not job_response.ok:
        raise RuntimeError(f"Pipeline claim failed {job_response.status_code}: {job_response.text}")
    job_response.raise_for_status()
    job = job_response.json()
    providers = job.get("providers") or {}
    os.environ["OPENAI_API_KEY"] = str(providers.get("openaiApiKey") or "")
    os.environ["RUNWAY_API_KEY"] = str(providers.get("runwayApiKey") or "")
    os.environ["ELEVENLABS_API_KEY"] = str(providers.get("elevenLabsApiKey") or "")
    os.environ["ELEVENLABS_VOICE_ID"] = str(providers.get("elevenLabsVoiceId") or "")
    os.environ["ELEVENLABS_MODEL_ID"] = str(providers.get("elevenLabsModelId") or "eleven_flash_v2_5")
    for required_provider in ("OPENAI_API_KEY", "RUNWAY_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"):
        _required(required_provider)
    tier = job.get("tier") or "standard_hybrid"
    if tier not in {"signature_human", "standard_hybrid", "premium_full_motion"}:
        raise ValueError("This worker accepts Main Character Studios production orders only.")
    if job.get("contract", {}).get("petRouting") != "runway-gen4-turbo-only" or job.get("contract", {}).get("animalPoseDetection") is not False:
        raise ValueError("Pet scenes must use Runway directly with animal pose detection disabled.")
    scene_count = int(job.get("contract", {}).get("scenes") or (6 if preview_mode else 0))
    movie_seconds = int(job.get("contract", {}).get("movieSeconds") or (60 if preview_mode else 0))

    def update(stage: str, scene: int = 0, status: str = "running", **extra):
        body = {"stage": stage, "status": status, **extra}
        if scene:
            body["scene"] = scene
        response = requests.patch(job_url, headers=_headers("application/json"), json=body, timeout=30)
        response.raise_for_status()
        return response.json()

    def upload(kind: str, path: str, scene: int = 0, content_type: str = "application/octet-stream"):
        headers = {**_headers(content_type), "x-mcs-asset-kind": kind}
        if scene:
            headers["x-mcs-scene"] = str(scene)
        response = requests.put(job["assets"]["upload"], headers=headers, data=Path(path).read_bytes(), timeout=180)
        response.raise_for_status()

    def scene_step(stage: str, number: int, action):
        try:
            return action()
        except Exception as error:
            provider_job_id = getattr(error, "provider_job_id", None)
            update(stage, number, "failed", error=str(error), providerJobId=provider_job_id)
            raise RuntimeError(f"Scene {number} stopped during {stage}; no duplicate paid provider request was created: {error}") from error

    if mode == "narration_rebuild":
        try:
            with tempfile.TemporaryDirectory(prefix=f"mcs-narration-{job_id}-") as folder:
                root = Path(folder)
                manifest = job.get("existingManifest") or {}
                scenes = manifest.get("scenes", [])
                validate_story_plan(manifest,scene_count)
                if len(scenes) != scene_count:
                    raise ValueError(f"Narration rebuild requires the complete {scene_count}-scene manifest.")
                videos, narrations, images = [], [], []
                update("narrating")
                for scene in scenes:
                    number = int(scene["sceneNumber"])
                    video_path = root / f"scene-{number}.mp4"
                    image_path = root / f"scene-{number}.png"
                    for url, path in (
                        (f"{job['assets']['previewScene']}?kind=scene-video&scene={number}", video_path),
                        (f"{job['assets']['previewScene']}?kind=scene-image&scene={number}", image_path),
                    ):
                        saved = requests.get(url, headers=_headers(), timeout=120)
                        saved.raise_for_status(); path.write_bytes(saved.content)
                    narration_path = root / f"narration-{number}.mp3"
                    narrate(str(scene["narration"]), str(narration_path))
                    upload("narration", str(narration_path), number, "audio/mpeg")
                    videos.append(str(video_path)); narrations.append(str(narration_path)); images.append(str(image_path))
                    runpod.serverless.progress_update(event, f"Corrected narration {number} of {scene_count}; existing Runway clip reused")
                update("assembling")
                movie_path = str(root / "story-video.mp4")
                build_movie(videos, narrations, folder, movie_path,movie_seconds)
                verify_movie(movie_path,movie_seconds)
                upload("final-movie", movie_path, content_type="video/mp4")
                update("verifying")
                pdf_path = str(root / "storybook.pdf")
                build_pdf(manifest, images, pdf_path)
                upload("storybook-pdf", pdf_path, content_type="application/pdf")
                update("ready", status="ready")
                return {"jobId": job_id, "status": "ready", "mode": mode, "completed": scene_count, "runwayClipsRegenerated": 0}
        except Exception as error:
            try: update("manual_review", status="failed", error=str(error))
            except Exception: pass
            return {"jobId": job_id, "status": "manual_review", "mode": mode, "error": str(error)}

    if preview_mode:
        try:
            with tempfile.TemporaryDirectory(prefix=f"mcs-preview-{job_id}-") as folder:
                root = Path(folder)
                reference = root / "reference.jpg"
                source = requests.get(job["assets"]["reference"], headers=_headers(), timeout=60)
                source.raise_for_status(); reference.write_bytes(source.content)
                manifest = job.get("existingManifest")
                if not manifest:
                    update("planning")
                    purchased_scene_count = 30 if str(job.get("tier") or "") == "premium_full_motion" else 18
                    manifest = plan_preview_story(str(job.get("vision") or ""), job.get("approvedPreview") or {}, purchased_scene_count)
                    update("planning", manifest=manifest)
                scenes = manifest.get("scenes", [])[:6]
                if len(manifest.get("scenes", [])) != 6 or len(scenes) != 6:
                    raise ValueError("The narrated preview requires exactly six distinct opening scenes.")
                validate_story_plan(manifest, 6, 1)
                def render_preview_scene(index, scene):
                    number = int(scene["sceneNumber"])
                    image_path = str(root / f"scene-{number}.png")
                    narration_path = str(root / f"narration-{number}.mp3")
                    if mode == "preview_sound_resume":
                        for kind, path in (("scene-image", image_path), ("narration", narration_path)):
                            saved = requests.get(f"{job['assets']['previewScene']}?kind={kind}&scene={number}", headers=_headers(), timeout=120)
                            saved.raise_for_status()
                            Path(path).write_bytes(saved.content)
                        update("narrating", number, "narrated")
                    else:
                        scene_step("illustrating", number, lambda s=scene, p=image_path: illustrate(
                            str(reference), s, p, False,
                            on_task_created=lambda task_id, **retry: update("illustrating", number, "provider_started", provider="runway-gen4-image-turbo", providerJobId=task_id, **retry),
                        ))
                        upload("scene-image", image_path, number, "image/png")
                        update("illustrating", number, "illustrated")
                        scene_step("narrating", number, lambda s=scene, p=narration_path: narrate(str(s["narration"]), p))
                        upload("narration", narration_path, number, "audio/mpeg")
                        update("narrating", number, "narrated")
                    sound_path = str(root / f"sound-{number}.mp3")
                    scene_step("sound", number, lambda s=scene, p=sound_path: sound_effect(s, p))
                    upload("sound-effect", sound_path, number, "audio/mpeg")
                    update("sound", number, "ready")
                    video_path = str(root / f"scene-{number}.mp4")
                    existing = (job.get("existingProviderJobs") or {}).get(str(number)) or {}
                    runway = RunwayGen4Turbo(_required("RUNWAY_API_KEY"), 10)
                    _, provider_job_id = scene_step("animating", number, lambda s=scene, p=video_path, e=existing: runway.animate(
                        image_path, p, str(s.get("visibleAction") or s.get("description") or s.get("narration") or ""),
                        existing_task_id=str(e.get("providerJobId") or "") or None,
                        on_task_created=lambda task_id, **retry: update("animating", number, "provider_started", provider="runway-gen4-turbo", providerJobId=task_id, **retry),
                    ))
                    verify_obvious_clip_motion(video_path)
                    upload("scene-video", video_path, number, "video/mp4")
                    update("animating", number, "animated", providerJobId=provider_job_id)
                    runpod.serverless.progress_update(event, f"Preview scene {index + 1} of 6 finished")
                    return index, image_path, narration_path, sound_path, video_path

                rendered = [None] * len(scenes)
                with ThreadPoolExecutor(max_workers=6) as executor:
                    futures = [executor.submit(render_preview_scene, index, scene) for index, scene in enumerate(scenes)]
                    for future in as_completed(futures):
                        index, image_path, narration_path, sound_path, video_path = future.result()
                        rendered[index] = (image_path, narration_path, sound_path, video_path)
                images = [item[0] for item in rendered]
                narrations = [item[1] for item in rendered]
                sounds = [item[2] for item in rendered]
                videos = [item[3] for item in rendered]
                validate_unique_scene_images(images)
                update("assembling")
                movie_path = str(root / "preview.mp4")
                build_movie(videos, narrations, folder, movie_path, 60, sounds=sounds)
                verify_movie(movie_path, 60)
                upload("preview-movie", movie_path, content_type="video/mp4")
                update("ready", status="ready", manifest=manifest)
                return {"jobId": job_id, "status": "ready", "mode": mode, "completed": 6}
        except Exception as error:
            try: update("manual_review", status="failed", error=str(error))
            except Exception: pass
            return {"jobId": job_id, "status": "manual_review", "mode": mode, "error": str(error)}

    try:
        with tempfile.TemporaryDirectory(prefix=f"mcs-{job_id}-") as folder:
            root = Path(folder)
            reference = root / "reference.jpg"
            source = requests.get(job["assets"]["reference"], headers=_headers(), timeout=60)
            source.raise_for_status(); reference.write_bytes(source.content)
            manifest = job.get("existingManifest")
            if not manifest:
                update("planning")
                manifest = plan_story(str(job.get("vision") or ""), job.get("approvedPreview") or {}, scene_count)
                update("planning", manifest=manifest)
            scenes = manifest.get("scenes", [])
            validate_story_plan(manifest, scene_count)
            if len(scenes) != scene_count:
                raise ValueError(f"The paid movie requires exactly {scene_count} scenes.")
            rendered = [None] * len(scenes)
            def render_scene(index, scene):
                number = int(scene["sceneNumber"])
                image_path = str(root / f"scene-{number}.png")
                narration_path = str(root / f"narration-{number}.mp3")
                scene_step("illustrating", number, lambda s=scene, p=image_path: illustrate(str(reference), s, p, False, on_task_created=lambda task_id, **retry: update("illustrating", number, "provider_started", provider="runway-gen4-image-turbo", providerJobId=task_id, **retry)))
                upload("scene-image", image_path, number, "image/png")
                scene_step("narrating", number, lambda s=scene, p=narration_path: narrate(str(s["narration"]), p))
                upload("narration", narration_path, number, "audio/mpeg")
                sound_path = str(root / f"sound-{number}.mp3")
                scene_step("sound", number, lambda s=scene, p=sound_path: sound_effect(s, p))
                upload("sound-effect", sound_path, number, "audio/mpeg")
                video_path = str(root / f"scene-{number}.mp4")
                existing = (job.get("existingProviderJobs") or {}).get(str(number)) or {}
                runway = RunwayGen4Turbo(_required("RUNWAY_API_KEY"), 10)
                _, provider_job_id = scene_step("animating", number, lambda s=scene, p=video_path, e=existing: runway.animate(image_path, p, str(s.get("visibleAction") or s.get("description") or s.get("narration") or ""), existing_task_id=str(e.get("providerJobId") or "") or None, on_task_created=lambda task_id, **retry: update("animating", number, "provider_started", provider="runway-gen4-turbo", providerJobId=task_id, **retry)))
                verify_obvious_clip_motion(video_path)
                upload("scene-video", video_path, number, "video/mp4")
                update("animating", number, "animated", providerJobId=provider_job_id)
                runpod.serverless.progress_update(event, f"Scene {index + 1} of {scene_count} finished")
                return index, image_path, narration_path, sound_path, video_path
            with ThreadPoolExecutor(max_workers=6) as executor:
                futures = [executor.submit(render_scene, index, scene) for index, scene in enumerate(scenes)]
                for future in as_completed(futures):
                    index, image_path, narration_path, sound_path, video_path = future.result()
                    rendered[index] = (image_path, narration_path, sound_path, video_path)
            images = [item[0] for item in rendered]; narrations = [item[1] for item in rendered]; sounds = [item[2] for item in rendered]; videos = [item[3] for item in rendered]
            validate_unique_scene_images(images)
            update("assembling")
            movie_path = str(root / "story-video.mp4")
            build_movie(videos, narrations, folder, movie_path, movie_seconds, sounds=sounds)
            verify_movie(movie_path, movie_seconds)
            upload("final-movie", movie_path, content_type="video/mp4")
            update("verifying")
            pdf_path = str(root / "storybook.pdf")
            build_pdf(manifest, images, pdf_path)
            upload("storybook-pdf", pdf_path, content_type="application/pdf")
            update("ready", status="ready")
            return {"jobId": job_id, "status": "ready", "tier": tier, "completed": scene_count}
    except Exception as error:
        try:
            update("manual_review", status="failed", error=str(error))
        except Exception:
            pass
        return {"jobId": job_id, "status": "manual_review", "tier": tier, "error": str(error)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
