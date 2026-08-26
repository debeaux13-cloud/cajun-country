"""RunPod Tier-1 worker for Main Character Studios production previews and paid continuation."""
from __future__ import annotations

import os
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
import runpod

from pipeline_steps import (
    build_movie,
    build_pdf,
    illustrate,
    narrate,
    sound_effect,
    plan_preview_story,
    plan_story,
    validate_story_plan,
    validate_unique_scene_images,
    verify_movie,
    verify_obvious_clip_motion,
)
from runway_adapter import RunwayGen4Turbo

BUNDLE_VERSION = "2026-08-26-frontdoor-v13"


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
    action = str(payload.get("action") or "")
    if action == "version":
        return {
            "status": "ready",
            "bundleVersion": BUNDLE_VERSION,
            "previewImageProvider": "runway-gen4-image-turbo",
            "previewSceneReuseAfterPayment": True,
        }

    supplied_worker_secret = str(payload.get("workerSecret") or "").strip()
    if supplied_worker_secret:
        os.environ["MCS_WORKER_SECRET"] = supplied_worker_secret

    job_id = str(payload.get("jobId") or "").strip()
    mode = str(payload.get("mode") or "paid").strip()
    callback_base = str(payload.get("callbackBase") or "").rstrip("/")
    if not job_id or not callback_base:
        raise ValueError("jobId and callbackBase are required")

    preview_mode = mode in {"preview", "preview_sound_resume"}
    job_url = (
        f"{callback_base}/api/internal/preview-pipeline/{job_id}"
        if preview_mode
        else f"{callback_base}/api/internal/pipeline/jobs/{job_id}"
    )
    response = requests.get(job_url, headers=_headers(), timeout=30)
    if not response.ok:
        raise RuntimeError(f"Pipeline claim failed {response.status_code}: {response.text}")
    job = response.json()

    providers = job.get("providers") or {}
    os.environ["AI_GATEWAY_API_KEY"] = str(providers.get("aiGatewayApiKey") or "")
    os.environ["OPENAI_API_KEY"] = str(providers.get("openaiApiKey") or "")
    os.environ["RUNWAY_API_KEY"] = str(providers.get("runwayApiKey") or "")
    os.environ["ELEVENLABS_API_KEY"] = str(providers.get("elevenLabsApiKey") or "")
    os.environ["ELEVENLABS_VOICE_ID"] = str(providers.get("elevenLabsVoiceId") or "")
    os.environ["ELEVENLABS_MODEL_ID"] = str(providers.get("elevenLabsModelId") or "eleven_flash_v2_5")

    for required_provider in ("RUNWAY_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"):
        _required(required_provider)

    tier = str(job.get("tier") or "premium_full_motion")
    if tier not in {"signature_human", "standard_hybrid", "premium_full_motion"}:
        raise ValueError("This worker accepts Main Character Studios production orders only.")
    if job.get("contract", {}).get("petRouting") != "runway-gen4-turbo-only":
        raise ValueError("Tier-1 movie scenes must route through Runway Gen-4 Turbo.")
    if job.get("contract", {}).get("animalPoseDetection") is not False:
        raise ValueError("Animal pose detection must remain disabled for this tier.")

    scene_count = int(job.get("contract", {}).get("scenes") or (6 if preview_mode else 30))
    movie_seconds = int(job.get("contract", {}).get("movieSeconds") or (60 if preview_mode else 300))

    def update(stage: str, scene: int = 0, status: str = "running", **extra):
        body = {"stage": stage, "status": status, **extra}
        if scene:
            body["scene"] = scene
        r = requests.patch(job_url, headers=_headers("application/json"), json=body, timeout=30)
        r.raise_for_status()
        return r.json()

    def upload(kind: str, path: str, scene: int = 0, content_type: str = "application/octet-stream"):
        headers = {**_headers(content_type), "x-mcs-asset-kind": kind}
        if scene:
            headers["x-mcs-scene"] = str(scene)
        r = requests.put(job["assets"]["upload"], headers=headers, data=Path(path).read_bytes(), timeout=180)
        r.raise_for_status()

    def download(kind: str, destination: str, scene: int = 0):
        url = f"{job['assets']['previewScene']}?kind={kind}"
        if scene:
            url += f"&scene={scene}"
        r = requests.get(url, headers=_headers(), timeout=120)
        r.raise_for_status()
        Path(destination).write_bytes(r.content)

    def scene_step(stage: str, number: int, action_fn):
        try:
            return action_fn()
        except Exception as error:
            provider_job_id = getattr(error, "provider_job_id", None)
            try:
                update(stage, number, "failed", error=str(error), providerJobId=provider_job_id)
            except Exception:
                pass
            raise RuntimeError(
                f"Scene {number} stopped during {stage}; no duplicate paid provider request was created: {error}"
            ) from error

    def render_scene(root: Path, reference: Path, scene: dict, index: int):
        number = int(scene["sceneNumber"])
        image_path = str(root / f"scene-{number}.png")
        narration_path = str(root / f"narration-{number}.mp3")
        sound_path = str(root / f"sound-{number}.mp3")
        video_path = str(root / f"scene-{number}.mp4")

        scene_step(
            "illustrating",
            number,
            lambda s=scene, p=image_path: illustrate(
                str(reference),
                s,
                p,
                True,
                on_task_created=lambda task_id, **retry: update(
                    "illustrating",
                    number,
                    "provider_started",
                    provider="runway-gen4-image-turbo",
                    providerJobId=task_id,
                    **retry,
                ),
            ),
        )
        upload("scene-image", image_path, number, "image/png")
        update("illustrating", number, "illustrated")

        scene_step("narrating", number, lambda s=scene, p=narration_path: narrate(str(s["narration"]), p))
        upload("narration", narration_path, number, "audio/mpeg")
        update("narrating", number, "narrated")

        scene_step("sound", number, lambda s=scene, p=sound_path: sound_effect(s, p))
        upload("sound-effect", sound_path, number, "audio/mpeg")
        update("sound", number, "ready")

        existing = (job.get("existingProviderJobs") or {}).get(str(number)) or {}
        runway = RunwayGen4Turbo(_required("RUNWAY_API_KEY"), 10)
        _, provider_job_id = scene_step(
            "animating",
            number,
            lambda s=scene, p=video_path, e=existing: runway.animate(
                image_path,
                p,
                str(s.get("visibleAction") or s.get("description") or s.get("narration") or ""),
                existing_task_id=str(e.get("providerJobId") or "") or None,
                on_task_created=lambda task_id, **retry: update(
                    "animating",
                    number,
                    "provider_started",
                    provider="runway-gen4-turbo",
                    providerJobId=task_id,
                    **retry,
                ),
            ),
        )
        verify_obvious_clip_motion(video_path)
        upload("scene-video", video_path, number, "video/mp4")
        update("animating", number, "animated", providerJobId=provider_job_id)
        runpod.serverless.progress_update(event, f"Scene {index} finished")
        return image_path, narration_path, sound_path, video_path

    if preview_mode:
        try:
            with tempfile.TemporaryDirectory(prefix=f"mcs-preview-{job_id}-") as folder:
                root = Path(folder)
                reference = root / "reference.jpg"
                source = requests.get(job["assets"]["reference"], headers=_headers(), timeout=60)
                source.raise_for_status()
                reference.write_bytes(source.content)

                manifest = job.get("existingManifest") or {}
                if not manifest:
                    update("planning")
                    purchased_scene_count = 30 if tier == "premium_full_motion" else 18
                    manifest = plan_preview_story(
                        str(job.get("vision") or ""),
                        job.get("approvedPreview") or {},
                        purchased_scene_count,
                    )
                    update("planning", manifest=manifest)
                validate_story_plan(manifest, 6, 1)
                scenes = list(manifest.get("scenes") or [])

                rendered = [None] * 6
                with ThreadPoolExecutor(max_workers=6) as executor:
                    futures = {
                        executor.submit(render_scene, root, reference, scene, index): index - 1
                        for index, scene in enumerate(scenes, start=1)
                    }
                    for future in as_completed(futures):
                        rendered[futures[future]] = future.result()

                images = [item[0] for item in rendered]
                narrations = [item[1] for item in rendered]
                sounds = [item[2] for item in rendered]
                videos = [item[3] for item in rendered]
                validate_unique_scene_images(images)

                update("assembling")
                movie_path = str(root / "preview.mp4")
                build_movie(
                    videos,
                    narrations,
                    folder,
                    movie_path,
                    60,
                    sound_effect_paths=sounds,
                )
                verify_movie(movie_path, 60)
                upload("preview-movie", movie_path, content_type="video/mp4")
                update("ready", status="ready", manifest=manifest)
                return {"jobId": job_id, "status": "ready", "mode": mode, "completed": 6}
        except Exception as error:
            try:
                update("manual_review", status="failed", error=str(error))
            except Exception:
                pass
            return {"jobId": job_id, "status": "manual_review", "mode": mode, "error": str(error)}

    try:
        with tempfile.TemporaryDirectory(prefix=f"mcs-paid-{job_id}-") as folder:
            root = Path(folder)
            reference = root / "reference.jpg"
            source = requests.get(job["assets"]["reference"], headers=_headers(), timeout=60)
            source.raise_for_status()
            reference.write_bytes(source.content)

            manifest = job.get("existingManifest") or {}
            current_scenes = list(manifest.get("scenes") or [])
            if len(current_scenes) not in {6, scene_count}:
                opening = job.get("openingManifest") or (manifest if len(current_scenes) == 6 else {})
                if not (os.environ.get("AI_GATEWAY_API_KEY", "").strip() or os.environ.get("OPENAI_API_KEY", "").strip()):
                    raise RuntimeError("Paid continuation needs the saved full manifest or AI Gateway authentication.")
                update("planning")
                manifest = plan_story(
                    str(job.get("vision") or ""),
                    job.get("approvedPreview") or {},
                    tier,
                    opening,
                    scene_count,
                )
                update("planning", manifest=manifest)
            validate_story_plan(manifest, scene_count)
            scenes = list(manifest.get("scenes") or [])

            rendered = [None] * scene_count
            for index, scene in enumerate(scenes[:6], start=1):
                number = int(scene["sceneNumber"])
                image_path = str(root / f"scene-{number}.png")
                narration_path = str(root / f"narration-{number}.mp3")
                sound_path = str(root / f"sound-{number}.mp3")
                video_path = str(root / f"scene-{number}.mp4")
                try:
                    download("scene-image", image_path, number)
                    download("narration", narration_path, number)
                    download("sound-effect", sound_path, number)
                    download("scene-video", video_path, number)
                except Exception as error:
                    raise RuntimeError(
                        f"Paid continuation will not regenerate preview scene {number}; saved preview asset is missing: {error}"
                    ) from error
                rendered[index - 1] = (image_path, narration_path, sound_path, video_path)

            remaining = scenes[6:]
            with ThreadPoolExecutor(max_workers=6) as executor:
                futures = {
                    executor.submit(render_scene, root, reference, scene, index): index - 1
                    for index, scene in enumerate(remaining, start=7)
                }
                for future in as_completed(futures):
                    rendered[futures[future]] = future.result()

            images = [item[0] for item in rendered]
            narrations = [item[1] for item in rendered]
            sounds = [item[2] for item in rendered]
            videos = [item[3] for item in rendered]
            validate_unique_scene_images(images)

            update("assembling")
            movie_path = str(root / "story-video.mp4")
            build_movie(
                videos,
                narrations,
                folder,
                movie_path,
                movie_seconds,
                sound_effect_paths=sounds,
            )
            verify_movie(movie_path, movie_seconds)
            upload("final-movie", movie_path, content_type="video/mp4")

            update("verifying")
            pdf_path = str(root / "storybook.pdf")
            build_pdf(manifest, images, pdf_path)
            upload("storybook-pdf", pdf_path, content_type="application/pdf")
            update("ready", status="ready", manifest=manifest)
            return {"jobId": job_id, "status": "ready", "tier": tier, "completed": scene_count}
    except Exception as error:
        try:
            update("manual_review", status="failed", error=str(error))
        except Exception:
            pass
        return {"jobId": job_id, "status": "manual_review", "tier": tier, "error": str(error)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
