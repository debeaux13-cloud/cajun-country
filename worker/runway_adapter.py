"""Runway Gen-4 Turbo image-to-video adapter for full-motion scenes."""
from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path

import requests


ANIMATION_DIRECTIVE = (
    "WARM STYLIZED 3D CGI MOVIE. Preserve source identity, anatomy, face, colors/markings, hair/fur, clothing, props, setting, rounded sculpted forms, tactile surfaces, soft light, gentle highlights, and shallow depth. "
    "Keep weight/volume; form through light/shadow, no hard outlines. Never photoreal/live-action or flat 2D/vector. "
    "Source frame precedes action. Hero completes the timed action with continuous travel, joint changes, weight shifts, expressions, blinking, breathing, and hair/fur/clothing response. "
    "Camera/ambient motion never replaces hero motion. No identity drift, morphing, extra limbs, changed ears/tail, frozen/hovering/held pose, pan/zoom-only shot, or slideshow."
)


def locked_animation_prompt(scene_prompt: str) -> str:
    """Keep the visual and motion contracts inside Runway's 1,000-character limit."""
    directive = ANIMATION_DIRECTIVE
    available = max(0, 1000 - len(directive) - 2)
    scene = " ".join(str(scene_prompt or "").split())[:available].rstrip()
    return f"{scene} {directive}".strip()


class RunwayTaskError(RuntimeError):
    def __init__(self, task_id: str, message: str):
        super().__init__(message)
        self.provider_job_id = task_id


class RunwayGen4Turbo:
    def __init__(self, api_key: str, duration: int = 4):
        self.api_key = api_key
        self.duration = duration
        self.base = "https://api.dev.runwayml.com/v1"
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Runway-Version": "2024-11-06",
        }
        self._simple_prompt_sources: set[str] = set()

    def animate(self, source: str, destination: str, prompt: str, *, existing_task_id: str | None = None, on_task_created=None) -> tuple[str, str]:
        max_bad_output_retries = 2
        max_safety_output_retries = 1
        bad_output_retries = 0
        safety_output_retries = 0
        task_id = str(existing_task_id or "").strip()
        prompt_image = ""
        prompt_text = locked_animation_prompt(prompt)

        def create_task(retry_evidence: dict | None = None) -> str:
            nonlocal prompt_image
            if not prompt_image:
                image = Path(source).read_bytes()
                mime = "image/png" if source.lower().endswith(".png") else "image/jpeg"
                prompt_image = f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"
            response = None
            # Only an explicit 429 is retried here. It has no accepted provider
            # task and therefore cannot create a duplicate billable render.
            for attempt in range(3):
                response = requests.post(
                    f"{self.base}/image_to_video",
                    headers=self.headers,
                    json={
                        "model": "gen4_turbo",
                        "promptImage": prompt_image,
                        "promptText": prompt_text,
                        "ratio": "1280:720",
                        "duration": self.duration,
                    },
                    timeout=60,
                )
                if response.status_code != 429 or attempt == 2:
                    break
                retry_after = response.headers.get("retry-after", "")
                try:
                    delay = float(retry_after)
                except ValueError:
                    delay = 2 ** (attempt + 1)
                time.sleep(min(30.0, max(2.0, delay)))
            assert response is not None
            if not response.ok:
                raise RuntimeError(f"Runway image-to-video request failed ({response.status_code}): {response.text[:500]}")
            created_task_id = str(response.json()["id"])
            if on_task_created:
                on_task_created(created_task_id, **(retry_evidence or {}))
            return created_task_id

        if not task_id:
            if source in self._simple_prompt_sources:
                prompt_text = locked_animation_prompt("The same principal character performs the visible story action naturally while the camera stays steady. Preserve the exact character, anatomy, setting, props, and warm stylized 3D CGI design.")
            task_id = create_task()
        deadline = time.monotonic() + 12 * 60
        while True:
            if time.monotonic() >= deadline:
                raise RunwayTaskError(task_id, f"Runway task {task_id} exceeded the 12-minute scene limit; the same task must be checked, never replaced.")
            task = requests.get(f"{self.base}/tasks/{task_id}", headers=self.headers, timeout=30)
            task.raise_for_status()
            payload = task.json()
            if payload.get("status") == "SUCCEEDED":
                output_url = (payload.get("output") or [None])[0]
                if not output_url:
                    raise RuntimeError("Runway completed without an output URL.")
                video = requests.get(output_url, timeout=120)
                video.raise_for_status()
                Path(destination).write_bytes(video.content)
                return destination, task_id
            if payload.get("status") in {"FAILED", "CANCELLED"}:
                self._simple_prompt_sources.add(source)
                failure_code = str(payload.get("failureCode") or "")
                credits = (payload.get("cost") or {}).get("credits")
                zero_cost_failure = isinstance(credits, (int, float)) and not isinstance(credits, bool) and credits == 0
                retryable_bad_output = payload.get("status") == "FAILED" and failure_code.startswith("INTERNAL.BAD_OUTPUT.") and zero_cost_failure
                if retryable_bad_output and bad_output_retries < max_bad_output_retries:
                    bad_output_retries += 1
                    time.sleep(2 ** bad_output_retries)
                    prior_task_id = task_id
                    task_id = create_task({
                        "retryAttempt": bad_output_retries,
                        "priorProviderJobId": prior_task_id,
                        "priorFailureCode": failure_code,
                        "priorCredits": credits,
                    })
                    deadline = time.monotonic() + 12 * 60
                    continue
                retryable_safety_output = payload.get("status") == "FAILED" and failure_code == "SAFETY.OUTPUT.VIDEO" and zero_cost_failure
                if retryable_safety_output and safety_output_retries < max_safety_output_retries:
                    safety_output_retries += 1
                    prompt_text = locked_animation_prompt(
                        "Wholesome family-friendly animated scene. Fully clothed characters perform the simple visible story action with friendly expressions and comfortable personal space. Preserve exact identity, anatomy, clothing, setting, and warm stylized 3D CGI design. No kissing, intimate embrace, suggestive contact, violence, injury, danger, or frightening imagery."
                    )
                    time.sleep(2)
                    prior_task_id = task_id
                    task_id = create_task({
                        "retryAttempt": safety_output_retries,
                        "priorProviderJobId": prior_task_id,
                        "priorFailureCode": failure_code,
                        "priorCredits": credits,
                    })
                    deadline = time.monotonic() + 12 * 60
                    continue
                detail = payload.get("failure") or payload.get("failureReason") or payload.get("error") or payload.get("failureCode") or "No provider reason returned"
                runway_failure_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)[:4000]
                raise RunwayTaskError(
                    task_id,
                    f"Runway task {task_id} ended with {payload.get('status')}: {str(detail)[:500]}. Full Runway response: {runway_failure_payload}",
                )
            time.sleep(4)

    @property
    def cost_cents(self) -> int:
        return self.duration * int(os.environ.get("RUNWAY_CENTS_PER_SECOND", "5"))
