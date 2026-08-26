"""RunPod Tier-1 worker for Main Character Studios $49 production flow."""
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
    validate_story_plan,
    validate_unique_scene_images,
    verify_movie,
    verify_obvious_clip_motion,
)
from runway_adapter import RunwayGen4Turbo

BUNDLE_VERSION = "2026-08-26-mcs-49-three-minute-v14"


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
    if str(payload.get("action") or "") == "version":
        return {
            "status": "ready",
            "bundleVersion": BUNDLE_VERSION,
            "product": "$49 / 3 minutes / 18 scenes",
            "previewScenes": 6,
            "paidContinuationScenes": 12,
            "previewSceneReuseAfterPayment": True,
            "directBlobUploads": True,
            "soundEffects": True,
            "backgroundMusic": True,
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
    for name in ("RUNWAY_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"):
        _required(name)

    if job.get("contract", {}).get("petRouting") != "runway-gen4-turbo-only":
        raise ValueError("Every MCS scene must route through Runway Gen-4 Turbo.")
    if job.get("contract", {}).get("animalPoseDetection") is not False:
        raise ValueError("Animal pose detection must remain disabled for this tier.")

    scene_count = int(job.get("contract", {}).get("scenes") or (6 if preview_mode else 18))
    movie_seconds = int(job.get("contract", {}).get("movieSeconds") or (60 if preview_mode else 180))

    def update(stage: str, scene: int = 0, status: str = "running", **extra):
        body = {"stage": stage, "status": status, **extra}
        if scene:
            body["scene"] = scene
        r = requests.patch(job_url, headers=_headers("application/json"), json=body, timeout=30)
        r.raise_for_status()
        return r.json()

    def upload(kind: str, path: str, scene: int = 0, content_type: str = "application/octet-stream"):
        data = Path(path).read_bytes()
        ticket_url = f"{callback_base}/api/internal/pipeline/jobs/{job_id}/upload-ticket"
        ticket = requests.post(
            ticket_url,
            headers=_headers("application/json"),
            json={"kind": kind, "scene": scene or "", "contentType": content_type, "size": len(data)},
            timeout=30,
        )
        if ticket.ok:
            presigned = str((ticket.json() or {}).get("presignedUrl") or "")
            if presigned:
                sent = requests.put(presigned, headers={"Content-Type": content_type}, data=data, timeout=600)
                sent.raise_for_status()
                return
        # Small-file compatibility fallback only. Never send a large MP4 through
        # a Vercel Function because the platform body limit will return 413.
        if len(data) > 4_000_000:
            raise RuntimeError(f"Direct Blob upload ticket failed for {kind} ({ticket.status_code}): {ticket.text[:500]}")
        headers = {**_headers(content_type), "x-mcs-asset-kind": kind}
        if scene:
            headers["x-mcs-scene"] = str(scene)
        fallback = requests.put(job["assets"]["upload"], headers=headers, data=data, timeout=180)
        fallback.raise_for_status()

    def download(kind: str, destination: str, scene: int = 0):
        url = f"{job['assets']['previewScene']}?kind={kind}"
        if scene:
            url += f"&scene={scene}"
        r = requests.get(url, headers=_headers(), timeout=180)
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
            lambda: illustrate(
                str(reference), scene, image_path, True,
                on_task_created=lambda task_id, **retry: update(
                    "illustrating", number, "provider_started",
                    provider="runway-gen4-image-turbo", providerJobId=task_id, **retry,
                ),
            ),
        )
        upload("scene-image", image_path, number, "image/png")
        update("illustrating", number, "illustrated")

        scene_step("narrating", number, lambda: narrate(str(scene["narration"]), narration_path))
        upload("narration", narration_path, number, "audio/mpeg")
        update("narrating", number, "narrated")

        scene_step("sound", number, lambda: sound_effect(scene, sound_path))
        upload("sound-effect", sound_path, number, "audio/mpeg")
        update("sound", number, "ready")

        runway = RunwayGen4Turbo(_required("RUNWAY_API_KEY"), 10)
        existing = (job.get("existingProviderJobs") or {}).get(str(number)) or {}
        _, provider_job_id = scene_step(
            "animating",
            number,
            lambda: runway.animate(
                image_path,
                video_path,
                str(scene.get("visibleAction") or scene.get("description") or scene.get("narration") or ""),
                existing_task_id=str(existing.get("providerJobId") or "") or None,
                on_task_created=lambda task_id, **retry: update(
                    "animating", number, "provider_started",
                    provider="runway-gen4-turbo", providerJobId=task_id, **retry,
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
                build_movie(videos, narrations, folder, movie_path, 60, sound_effect_paths=sounds)
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
            validate_story_plan(manifest, scene_count)
            scenes = list(manifest.get("scenes") or [])
            if scene_count != 18 or movie_seconds != 180:
                raise ValueError("Live paid MCS product must be exactly 18 scenes / 180 seconds.")

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

            with ThreadPoolExecutor(max_workers=6) as executor:
                futures = {
                    executor.submit(render_scene, root, reference, scene, index): index - 1
                    for index, scene in enumerate(scenes[6:], start=7)
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
            build_movie(videos, narrations, folder, movie_path, 180, sound_effect_paths=sounds)
            verify_movie(movie_path, 180)
            upload("final-movie", movie_path, content_type="video/mp4")

            update("verifying")
            pdf_path = str(root / "storybook.pdf")
            build_pdf(manifest, images, pdf_path)
            upload("storybook-pdf", pdf_path, content_type="application/pdf")
            update("ready", status="ready", manifest=manifest)
            return {"jobId": job_id, "status": "ready", "tier": "three_minute", "completed": 18, "movieSeconds": 180}
    except Exception as error:
        try:
            update("manual_review", status="failed", error=str(error))
        except Exception:
            pass
        return {"jobId": job_id, "status": "manual_review", "tier": "three_minute", "error": str(error)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
