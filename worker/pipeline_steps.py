"""Tier-neutral planning, illustration, narration, PDF and FFmpeg steps."""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import requests
from PIL import Image, ImageChops, ImageStat
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

SCENES = 30
MOVIE_SECONDS = 300
TRANSITION_SECONDS = 0.5
ELEVENLABS_TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech"
ELEVENLABS_SFX_ENDPOINT = "https://api.elevenlabs.io/v1/sound-generation"
ELEVENLABS_DEFAULT_MODEL = "eleven_flash_v2_5"
ELEVENLABS_ALLOWED_MODELS = {"eleven_flash_v2_5", "eleven_turbo_v2_5"}
_FFMPEG_INSTALL_LOCK = threading.Lock()


def verify_obvious_clip_motion(video_path: str) -> None:
    """Reject only clips that are effectively frozen.

    The former fixed center-frame "hero dominance" rule falsely rejected
    moving cinematic clips when the subject was off-center or the camera moved.
    """
    _ensure_ffmpeg()
    frame_dir = Path(video_path).with_suffix("").parent / f"{Path(video_path).stem}-motion-check"
    frame_dir.mkdir(parents=True, exist_ok=True)
    samples = []
    for index, second in enumerate((0.5, 2.5, 5.0, 7.5, 9.5), start=1):
        target = frame_dir / f"frame-{index}.png"
        subprocess.run([
            "ffmpeg", "-v", "error", "-ss", str(second), "-i", video_path,
            "-frames:v", "1", "-vf", "scale=320:180", "-y", str(target),
        ], check=True, timeout=60)
        with Image.open(target) as image:
            samples.append(image.convert("RGB").copy())
    # The earlier gate averaged one large center crop. Moving lightning, leaves,
    # water, or a tracking camera could therefore pass while the principal
    # character stayed frozen. Require sustained change through several hero-
    # sized interior regions and do not count the decorative outer frame.
    regions = (
        (72, 22, 248, 88),   # head / torso band
        (64, 48, 256, 132),  # principal-character core
        (72, 88, 248, 166),  # arms / legs / paws band
    )
    border_regions = (
        (0, 0, 64, 180),
        (256, 0, 320, 180),
        (64, 0, 256, 22),
        (64, 166, 256, 180),
    )
    region_changes = []
    border_changes = []
    for earlier, later in zip(samples, samples[1:]):
        values = []
        for box in regions:
            stat = ImageStat.Stat(ImageChops.difference(earlier.crop(box), later.crop(box)))
            values.append(sum(stat.mean) / len(stat.mean))
        region_changes.append(values)
        outside = []
        for box in border_regions:
            stat = ImageStat.Stat(ImageChops.difference(earlier.crop(box), later.crop(box)))
            outside.append(sum(stat.mean) / len(stat.mean))
        border_changes.append(sum(outside) / len(outside))
    core = [values[1] for values in region_changes]
    interior = [sum(values) / len(values) for values in region_changes]
    active_intervals = sum(value >= 3.0 for value in interior)
    strongly_active_intervals = sum(value >= 8.0 for value in interior)

    # Two clearly moving intervals are sufficient for a ten-second cinematic
    # shot. Subject placement and intentional camera motion are not failures.
    effectively_frozen = (
        active_intervals < 2
        and strongly_active_intervals == 0
        and max(core, default=0.0) < 5.0
    )
    if effectively_frozen:
        raise RuntimeError(
            f"Motion quality check rejected an effectively frozen clip (interior {region_changes}; border {border_changes}); stopped before assembly."
        )


def _ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return
    # Six preview scenes render concurrently. Package management is process-wide
    # and must never be entered by all six scene threads at once.
    with _FFMPEG_INSTALL_LOCK:
        if shutil.which("ffmpeg") and shutil.which("ffprobe"):
            return
        env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
        subprocess.run(["apt-get", "update"], check=True, timeout=180, env=env)
        subprocess.run(["apt-get", "install", "-y", "--no-install-recommends", "ffmpeg", "ca-certificates"], check=True, timeout=300, env=env)
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise RuntimeError("FFmpeg installation did not provide ffmpeg and ffprobe.")


def _post_with_throttle_retry(url: str, *, attempts: int = 3, **kwargs):
    response = None
    for attempt in range(attempts):
        response = requests.post(url, **kwargs)
        if response.status_code != 429 or attempt == attempts - 1:
            return response
        retry_after = response.headers.get("retry-after", "")
        try:
            delay = float(retry_after)
        except ValueError:
            delay = 2 ** (attempt + 1)
        time.sleep(min(30.0, max(2.0, delay)))
    return response


def _auth() -> dict[str, str]:
    key = os.environ.get("AI_GATEWAY_API_KEY", "").strip() or os.environ.get("OPENAI_API_KEY", "").strip()
    return {"Authorization": f"Bearer {key}"}


def _planning_endpoint_and_model() -> tuple[str, str]:
    if os.environ.get("AI_GATEWAY_API_KEY", "").strip():
        return "https://ai-gateway.vercel.sh/v1/responses", "openai/gpt-5.4"
    return "https://api.openai.com/v1/responses", "gpt-5-mini"


def validate_story_plan(plan: dict, expected_scenes: int = SCENES, first_scene: int = 1) -> None:
    scenes = plan.get("scenes") or []
    if len(scenes) != expected_scenes:
        raise ValueError(f"The story planner must return exactly {expected_scenes} scenes.")
    expected_numbers = list(range(first_scene, first_scene + expected_scenes))
    if [item.get("sceneNumber") for item in scenes] != expected_numbers:
        raise ValueError(f"Planner did not return scenes numbered {expected_numbers[0]} through {expected_numbers[-1]}.")
    narrations = [re.findall(r"[a-z0-9']+", str(scene.get("narration") or "").lower()) for scene in scenes]
    normalized_narrations = [" ".join(words) for words in narrations]
    descriptions = {" ".join(str(scene.get("description") or "").lower().split()) for scene in scenes}
    actions = {" ".join(str(scene.get("visibleAction") or "").lower().split()) for scene in scenes}
    if len(set(normalized_narrations)) != expected_scenes:
        raise ValueError("The story repeats narration instead of advancing through distinct scenes.")
    minimum_distinct = max(5, (expected_scenes * 4 + 4) // 5)
    if len(descriptions) < minimum_distinct or len(actions) < minimum_distinct:
        raise ValueError("The story does not contain enough distinct visual events for the requested movie section.")
    repeated_phrases: dict[str, int] = {}
    for words in narrations:
        for index in range(max(0, len(words) - 5)):
            phrase = " ".join(words[index:index + 6])
            repeated_phrases[phrase] = repeated_phrases.get(phrase, 0) + 1
    offenders = [phrase for phrase, count in repeated_phrases.items() if count > 3]
    if offenders:
        raise ValueError(f"The story uses a repeated narration template: {offenders[0]}")
    for scene in scenes:
        beats = [str(value).strip() for value in (scene.get("motionBeats") or []) if str(value).strip()]
        if len(beats) != 3:
            raise ValueError("Every scene requires three timed motion beats so the character acts throughout the shot.")
        visible_action = str(scene.get("visibleAction") or "").strip()
        action_verbs = [str(value).strip() for value in (scene.get("keyActionVerbs") or []) if str(value).strip()]
        # actionDensity/staticLevel are subjective planner self-scores. A romantic dance,
        # page turn, or quiet reunion can be fully animated while the model scores its
        # "action" below an arbitrary numeric threshold. Gate the plan on its concrete
        # timed motion contract instead; rendered clips still face the objective motion
        # analysis in verify_obvious_clip_motion before checkout can unlock.
        if not visible_action or len(action_verbs) < 2:
            raise ValueError("Every movie scene must be planned for sustained action, not a mostly static illustration.")


def validate_unique_scene_images(image_paths: list[str]) -> None:
    hashes = [hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in image_paths]
    if len(set(hashes)) != len(hashes):
        raise ValueError("Duplicate scene artwork detected. Every movie scene must have its own setting and composition before animation begins.")


def _difference_hash(path: str, size: int = 16) -> int:
    with Image.open(path) as image:
        pixels = list(image.convert("L").resize((size + 1, size), Image.Resampling.LANCZOS).getdata())
    value = 0
    for row in range(size):
        for column in range(size):
            value = (value << 1) | int(pixels[row * (size + 1) + column] > pixels[row * (size + 1) + column + 1])
    return value


def _reject_reference_background(reference_path: str, scene_path: str) -> None:
    reference_bytes = Path(reference_path).read_bytes()
    scene_bytes = Path(scene_path).read_bytes()
    if reference_bytes == scene_bytes:
        raise ValueError("The scene generator copied the uploaded reference photo instead of creating the requested location.")
    reference_hash = _difference_hash(reference_path)
    scene_hash = _difference_hash(scene_path)
    changed_bits = (reference_hash ^ scene_hash).bit_count()
    if changed_bits < 34:
        raise ValueError("The scene generator preserved too much of the uploaded reference background. The movie stopped before animation credits were used.")


def _fallback_plan(vision: str, approved_preview: dict) -> dict:
    """Deterministic customer-story expansion when the text planner is throttled."""
    story = " ".join((vision or str(approved_preview.get("story") or "")).split()).strip()
    if not story:
        story = "The main character begins a meaningful adventure and returns home changed."
    subject_match = re.search(r"\b([A-Z][A-Za-z'’-]{1,30})\b", story)
    subject = subject_match.group(1) if subject_match else "The main character"
    pet_present = bool(re.search(r"\b(dog|cat|pet|doberman|puppy|kitten|hound|terrier|retriever)\b", story, re.I))
    remi_story = bool(re.search(r"\bRemi\b", story, re.I))
    title = "Remi’s World Tour" if remi_story else f"{subject} — The Story Comes Alive"
    subtitle = "A famous Doberman’s adventure for treats, travel, and fan snuggles" if remi_story else "A personalized moving story"
    if remi_story:
        beats = [
            ("home studio", "poses beneath warm lights while her travel cases are packed", "confident"),
            ("airport terminal", "trots toward the departure gate as admirers wave", "excited"),
            ("airplane cabin", "settles by the window and watches clouds drift past", "curious"),
            ("Paris boulevard", "strides past café tables while photographers turn toward her", "glamorous"),
            ("Paris fashion set", "holds a proud pose as silk banners ripple behind her", "radiant"),
            ("London street", "walks through a cheerful crowd greeting fans", "joyful"),
            ("London studio", "turns toward the camera as flashes sparkle", "playful"),
            ("Rome plaza", "prances beside fountains while visitors applaud", "delighted"),
            ("Rome photo set", "balances perfectly while a scarf dances in the breeze", "focused"),
            ("Tokyo crossing", "moves through glowing signs as fans gather safely nearby", "energetic"),
            ("Tokyo rooftop", "looks across the skyline before beginning another pose", "bold"),
            ("Sydney harbor", "runs along the promenade with the sails behind her", "free"),
            ("Sydney set", "spins toward the lens and lifts her ears proudly", "spirited"),
            ("New York avenue", "walks like a runway star while city lights stream around her", "powerful"),
            ("New York studio", "finishes a dramatic turn and receives a favorite treat", "triumphant"),
            ("Mexico City garden", "greets families with a wagging tail and gentle bows", "affectionate"),
            ("garden portrait set", "poses among bright flowers while fans take pictures", "graceful"),
            ("mountain resort", "bounds through fresh snow and shakes sparkling flakes away", "adventurous"),
            ("fireside lounge", "rests briefly while accepting pets from new friends", "content"),
            ("tropical beach", "dashes beside the surf as her ears and collar move", "exhilarated"),
            ("sunset beach set", "stands against the glowing horizon and turns toward camera", "serene"),
            ("charity fan event", "walks between smiling guests and offers gentle greetings", "loving"),
            ("backstage dressing room", "chooses a sparkling collar before the final show", "anticipatory"),
            ("grand runway", "strides through moving spotlights as the audience cheers", "commanding"),
            ("grand runway", "pauses, turns, and gives her unmistakable Doberman pose", "proud"),
            ("celebration stage", "receives a bouquet and one favorite Ollie treat", "grateful"),
            ("fan meet-and-greet", "leans into careful snuggles while her tail moves happily", "tender"),
            ("journey home", "watches the world recede and settles beside her souvenirs", "peaceful"),
            ("homecoming walkway", "runs toward familiar faces waiting to welcome her", "overjoyed"),
            ("home studio", "rests among travel photographs, treats, and loving fan letters", "fulfilled"),
        ]
    else:
        stages = ["begins", "notices", "chooses", "prepares", "sets out", "explores", "meets a challenge", "responds", "learns", "moves forward", "finds a clue", "takes a risk", "helps", "adapts", "reaches the midpoint", "faces a setback", "regroups", "tries again", "discovers", "acts bravely", "draws closer", "solves a problem", "protects what matters", "reaches the climax", "makes the decisive choice", "celebrates", "reflects", "returns", "shares the lesson", "ends the adventure"]
        beats = [("the story world", f"{stage} while bringing this customer idea to life: {story[:180]}", "hopeful") for stage in stages]
    scenes, pages = [], []
    for index, (setting, action, tone) in enumerate(beats, start=1):
        narration = f"{subject} {action}, carrying the heart of the original story forward as this unforgettable adventure grows richer with every new moment."
        scene = {
            "sceneNumber": index,
            "description": f"Cinematic scene of {subject} in {setting}: {action}.",
            "characters": [subject],
            "setting": setting,
            "emotionalTone": tone,
            "keyActionVerbs": [word for word in re.findall(r"[A-Za-z]+", action)[:4]],
            "narration": narration,
            "visibleAction": action,
            "requiredVisibleDetails": [subject, setting],
            "motionBeats": [f"{subject} begins moving", action, f"{subject} reacts naturally"],
            "emotionalIntensity": min(10, 4 + index // 5),
            "actionDensity": 8,
            "staticLevel": 1,
            "petPresent": pet_present,
        }
        scenes.append(scene)
        pages.append({"sceneNumber": index, "text": narration})
    return {"title": title, "subtitle": subtitle, "pages": pages, "scenes": scenes}


def _plan_story_range(vision: str, approved_preview: dict, tier: str, first_scene: int, last_scene: int, prior_scenes: list[dict], total_scenes: int = SCENES) -> dict:
    """Plan one bounded one-minute chapter to avoid oversized, rate-limited responses."""
    count = last_scene - first_scene + 1
    scene = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "sceneNumber": {"type": "integer", "minimum": first_scene, "maximum": last_scene},
            "description": {"type": "string"},
            "characters": {"type": "array", "items": {"type": "string"}},
            "setting": {"type": "string"},
            "emotionalTone": {"type": "string"},
            "keyActionVerbs": {"type": "array", "items": {"type": "string"}},
            "narration": {"type": "string"},
            "visibleAction": {"type": "string"},
            "requiredVisibleDetails": {"type": "array", "items": {"type": "string"}},
            "motionBeats": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "string"}},
            "emotionalIntensity": {"type": "integer", "minimum": 0, "maximum": 10},
            "actionDensity": {"type": "integer", "minimum": 0, "maximum": 10},
            "staticLevel": {"type": "integer", "minimum": 0, "maximum": 10},
            "petPresent": {"type": "boolean"},
        },
        "required": ["sceneNumber", "description", "characters", "setting", "emotionalTone", "keyActionVerbs", "narration", "visibleAction", "requiredVisibleDetails", "motionBeats", "emotionalIntensity", "actionDensity", "staticLevel", "petPresent"],
    }
    schema = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "title": {"type": "string"}, "subtitle": {"type": "string"},
            "pages": {"type": "array", "minItems": count, "maxItems": count, "items": {"type": "object", "additionalProperties": False, "properties": {"sceneNumber": {"type": "integer"}, "text": {"type": "string"}}, "required": ["sceneNumber", "text"]}},
            "scenes": {"type": "array", "minItems": count, "maxItems": count, "items": scene},
        },
        "required": ["title", "subtitle", "pages", "scenes"],
    }
    minutes = total_scenes // 6
    word_range = "390-460" if total_scenes == 18 else "650-720"
    trait_data = approved_preview.get("character_traits") or {}
    trait_rules = _merged_trait_rules(trait_data)
    customer_notes = str(trait_data.get("customer_notes") or approved_preview.get("character_notes") or "").strip()
    consistency = "; ".join(trait_rules + ([f"Customer clarification: {customer_notes}"] if customer_notes else []))
    prompt = (
        f"The Runway moving movie with ElevenLabs narration is the primary product. Write exactly scenes {first_scene}-{last_scene} of a coherent {total_scenes}-scene, {minutes}-minute movie. "
        "The complete arc must have a strong opening, rising action, midpoint turn, escalating problem, climax, emotional resolution, and ending. This response is only one six-scene chapter of that arc. "
        "The customer may supply one sentence, polished prose, fragments, typos, shorthand, profanity, repeated thoughts, or events out of order. Customers are not expected to write a novel or screenplay. Preserve their intent, personality, names, relationships, facts, requested events, and ending while creating enough connected action to sustain the complete movie. Never replace their idea with a generic plot. "
        "WHEN THE CUSTOMER'S IDEA IS SHORT OR THIN, actively turn it into an entertaining movie: add logical connective events, visually distinct locations, playful complications, surprises, escalating stakes, humor appropriate to the subject, emotional turns, a payoff, and a satisfying ending. Harmless creative details may be invented when they support the customer's premise, but never invent a named loved one, change a supplied fact, or contradict the customer's story. Every scene must materially advance the plot; no filler, recycled event, repeated location posing, or paraphrase of the prior scene. "
        "STORY CAUSALITY RULE: every scene must contain a clear cause, a purposeful character action, and a visible consequence that creates the next beat. Give the character a concrete goal, make obstacles threaten that goal, build to a climax, and end with an earned payoff or resolution—not a list of unrelated actions and not a cutoff at the moment of discovery. "
        "SCENE TRUTH CONTRACT: description, setting, narration, visibleAction, and requiredVisibleDetails must name the same exact physical location, prop, and action. Never substitute an unrelated object or location: a mirror stays a mirror, a door stays a visible reachable door, and a carousel cannot replace either. The action must be physically achievable within the shot, causally continue the prior beat, and require the character to reach, touch, use, enter, open, or otherwise interact with the exact narrated object when the story calls for it. "
        "VISUAL WORLD RULE: Maya is only the benchmark for illustrated character treatment and continuous animation. Never copy Maya, Maple Grove, rabbits, a meadow, or any demo plot. Build the art direction from this customer's genre, tone, setting, and idea: space becomes a moving cosmic world, dinosaurs become a living prehistoric world, fantasy becomes magical, comedy becomes expressive, and grounded weddings or memories remain elegant and believable unless fantasy was requested. "
        "COMMERCIAL BRAND SAFETY: A brand name supplied by the customer may appear naturally in narration at most ONCE across the entire movie. After that single mention, use a generic description such as 'favorite treat,' 'shoes,' or 'phone.' Never write advertising copy, repeat a slogan, praise product benefits, show packaging or a logo, or imply sponsorship, endorsement, partnership, affiliation, or product placement. Do not introduce any brand the customer did not supply. "
        f"Each narration must be about 20-24 words, remain in the customer's original language, preserve the customer's voice and facts, and describe only details visible in that same scene. The complete {total_scenes}-scene movie should total roughly {word_range} narrated words. "
        "Never invent names, props, people, pets, or disconnected filler. Set petPresent true whenever a dog, cat, or other customer pet appears or is requested in that scene. Every requiredVisibleDetail must appear in visibleAction and description. "
        "Extract physical keyActionVerbs and score emotional intensity, action density, and static level from 0-10. Every scene needs three chronological motionBeats covering the opening, middle, and ending of its shot; actionDensity must be 7-10 and staticLevel 0-2. "
        f"CHARACTER CONSISTENCY IS NON-NEGOTIABLE IN EVERY SCENE: {consistency or 'preserve every visible identity trait from the reference image'}. Put these applicable constraints into requiredVisibleDetails and obey them in description and visibleAction. Never add, remove, lengthen, recolor, or morph a distinguishing trait. "
        f"The product tier is {tier}; do not choose hero scenes here. Customer story: {vision}\nApproved organized story: {json.dumps(approved_preview)}\n"
        f"Earlier locked scenes that must not be repeated or contradicted: {json.dumps(prior_scenes[-6:])}"
    )
    planning_endpoint, planning_model = _planning_endpoint_and_model()
    response = _post_with_throttle_retry(planning_endpoint, headers={**_auth(), "Content-Type": "application/json"}, json={
        "model": planning_model, "reasoning": {"effort": "minimal"}, "input": prompt,
        "text": {"format": {"type": "json_schema", "name": "mcs_thirty_scene_manifest", "strict": True, "schema": schema}},
        "max_output_tokens": 6500,
    }, timeout=300)
    if response.status_code == 429:
        raise RuntimeError("Story planning was throttled. The order stopped before creating repetitive fallback media.")
    response.raise_for_status()
    payload = response.json()
    raw = payload.get("output_text") or "".join(item.get("text", "") for output in payload.get("output", []) for item in output.get("content", []))
    plan = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    if consistency:
        for planned_scene in plan.get("scenes", []):
            planned_scene["description"] = f"{planned_scene.get('description', '')} HARD CHARACTER CONSISTENCY: {consistency}"[:1800]
            planned_scene["visibleAction"] = f"{planned_scene.get('visibleAction', '')}. Preserve throughout: {consistency}"[:1200]
            details = list(planned_scene.get("requiredVisibleDetails") or [])
            for rule in trait_rules:
                if rule not in details:
                    details.append(rule)
            if customer_notes:
                details.append(f"Customer clarification: {customer_notes}")
            planned_scene["requiredVisibleDetails"] = details[:24]
    validate_story_plan(plan, count, first_scene)
    return plan


def _merged_trait_rules(trait_data: dict) -> list[str]:
    """Keep both observed traits and hard negatives; neither list may hide the other."""
    merged: list[str] = []
    seen: set[str] = set()
    for value in list(trait_data.get("traits") or []) + list(trait_data.get("hard_constraints") or []):
        rule = str(value).strip()
        if rule and rule.casefold() not in seen:
            merged.append(rule)
            seen.add(rule.casefold())
    if str(trait_data.get("subject_type") or "").lower() in {"pet", "mixed"}:
        species = str(trait_data.get("species") or "").strip()
        breed = str(trait_data.get("breed") or "").strip()
        body = str(trait_data.get("healthy_body_description") or "").strip()
        sex = str(trait_data.get("sex") or "").strip()
        pronouns = str(trait_data.get("pronouns") or "").strip()
        if species and species.lower() != "unknown":
            merged.insert(0, f"SPECIES: {species}")
        if breed and breed.lower() != "unknown":
            merged.insert(1, f"BREED: {breed}; never substitute another breed")
        if body:
            merged.append(f"HEALTHY BODY CONDITION: {body}")
        if sex and sex.lower() != "unknown":
            merged.append(f"SEX: {sex}; never change the character's sex")
        if pronouns and pronouns.lower() != "unknown":
            merged.append(f"PRONOUNS: {pronouns}; use these consistently in every narration")
        merged.append(
            "WELL-CARED-FOR PET: healthy, well-fed natural build; no protruding ribs, skeletal frame, "
            "sunken waist, emaciation, neglect, grime, injury, or stray appearance"
        )
        merged.append(
            "TAIL CONSISTENCY: reproduce the exact visible tail length and shape from the reference photo; "
            "never invent, lengthen, curl, or enlarge a tail. If the tail is cropped, docked, absent, or unclear, "
            "keep the rear out of frame rather than inventing one."
        )
    return merged[:20]


def _preview_narrations(story: str) -> list[str]:
    """Create six complete narration beats without cutting a sentence mid-thought."""
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", story) if part.strip()]
    if len(sentences) < 6:
        known = {sentence.casefold().rstrip(".!?") for sentence in sentences}
        clauses = [part.strip(" ,;:—-") for part in re.split(r"[;—]|,\s+(?:and|but|while|as|then)\s+", story) if part.strip(" ,;:—-")]
        for clause in clauses:
            if clause and clause.casefold() not in known:
                sentences.append(clause[0].upper() + clause[1:] + ("" if clause[-1:] in ".!?" else "."))
                known.add(clause.casefold())
            if len(sentences) >= 6:
                break
    if len(sentences) >= 6:
        opening = sentences[:max(6, min(len(sentences), (len(sentences) + 2) // 3))]
        picks = [round(index * (len(opening) - 1) / 5) for index in range(6)]
        sentences = [opening[index] for index in picks]
    narrations: list[str] = []
    for index in range(6):
        source = sentences[index] if index < len(sentences) else ""
        if source and source[-1:] not in ".!?":
            source += "."
        # The story organizer already returns one bounded sentence per scene.
        # Never split at commas: that produced fragments such as "with a sharp."
        # and several seconds of dead air inside every ten-second scene.
        if not source and sentences:
            source = sentences[min(index, len(sentences) - 1)]
        narrations.append(source)
    return narrations


def _preview_plan_from_saved_story(vision: str, approved_preview: dict, total_scenes: int) -> dict:
    """Turn the already-expanded customer story into six preview scenes without another LLM call."""
    story = " ".join(str(
        approved_preview.get("organized_story")
        or approved_preview.get("expanded_story")
        or approved_preview.get("story")
        or vision
        or ""
    ).split()).strip()
    if not story:
        story = "The main character discovers an unexpected invitation and begins a vivid adventure filled with movement, wonder, and a meaningful destination."
    # A customer may type only a few words. Never reject that idea or ask them to
    # write the movie for us. Use complete sentences from the saved AI story and
    # complete cinematic bridges; never splice arbitrary word chunks together.
    narrations = _preview_narrations(story)
    trait_data = approved_preview.get("character_traits") or {}
    trait_rules = _merged_trait_rules(trait_data)
    customer_notes = str(trait_data.get("customer_notes") or approved_preview.get("character_notes") or "").strip()
    consistency = trait_rules + ([f"Customer clarification: {customer_notes}"] if customer_notes else [])
    featured = approved_preview.get("featured_names") or approved_preview.get("characters") or []
    if isinstance(featured, str):
        featured = [name.strip() for name in re.split(r"[,;&]", featured) if name.strip()]
    characters = [str(name).strip() for name in featured if str(name).strip()][:8]
    if not characters:
        named = re.search(r"\b([A-Z][A-Za-z'’-]{1,30})\b", story)
        characters = [named.group(1) if named else "The main character"]
    pet_present = bool(re.search(r"\b(dog|cat|pet|doberman|puppy|kitten|hound|terrier|retriever|animal)\b", story, re.I))
    if pet_present and trait_rules and characters:
        name = re.escape(characters[0])
        action = r"discovers|finds|enters|walks|runs|trots|notices|sees|hears|meets|begins|steps|moves|explores|approaches|follows|leaps|crosses|reaches|snaps|crouches|launches|flies|rockets|dives|dodges|tears|breaks|races|charges|sprints|jumps"
        narrations[0] = re.sub(
            rf"^({name}),\s+.*?(?=\b(?:{action})\b)",
            rf"\1 ",
            narrations[0], flags=re.I,
        )
    phases = [
        "launches immediately into the customer's requested world and reveals the inciting event",
        "chooses a clear goal and physically begins pursuing it",
        "meets a concrete obstacle whose consequence threatens that goal",
        "changes tactics as the obstacle escalates into the hardest challenge",
        "performs the decisive climactic action rather than merely posing near it",
        "achieves a visible payoff and lands on a satisfying emotional hook for the purchased continuation",
    ]
    tones = ["hooking", "determined", "tense", "escalating", "triumphant", "emotionally satisfying"]
    title = str(approved_preview.get("title") or approved_preview.get("story_title") or f"{characters[0]} — The Story Comes Alive").strip()
    subtitle = str(approved_preview.get("subtitle") or f"The opening minute of a personalized {total_scenes // 6}-minute movie").strip()
    scenes, pages = [], []
    for index, narration in enumerate(narrations, start=1):
        excerpt = narration[:420]
        motion = phases[index - 1]
        detail_rules = list(consistency)
        detail_rules.extend([characters[0], f"Opening story beat {index}"])
        scene = {
            "sceneNumber": index,
            "description": f"REFERENCE PHOTO OVERRIDES ANY CONFLICTING STORY DESCRIPTION. Stylized animated-storybook scene {index}, designed from this customer's genre and world rather than any demo: {excerpt} The composition and location must visibly differ from every other preview scene.",
            "characters": characters,
            "setting": f"The specific location described in opening story beat {index}: {excerpt}",
            "emotionalTone": tones[index - 1],
            "keyActionVerbs": ["moves", "reacts", "interacts", "advances"],
            "narration": narration,
            "visibleAction": f"{characters[0]} {motion}. Show the concrete events in this story beat with sustained full-body movement: {excerpt}",
            "requiredVisibleDetails": detail_rules[:24],
            "motionBeats": [
                f"0-3 seconds: {characters[0]} begins the scene's action immediately with visible full-body movement",
                f"3-7 seconds: {motion}; the character changes position and interacts with the story event",
                "7-10 seconds: the action reaches a visible result while foreground and background animation continues",
            ],
            "emotionalIntensity": min(10, 4 + index),
            "actionDensity": 9,
            "staticLevel": 0,
            "petPresent": pet_present,
        }
        if consistency:
            rules = "; ".join(consistency)
            scene["description"] = f"{scene['description']} HARD CHARACTER CONSISTENCY: {rules}"[:1800]
            scene["visibleAction"] = f"{scene['visibleAction']} Preserve throughout: {rules}"[:1200]
        scenes.append(scene)
        pages.append({"sceneNumber": index, "text": narration})
    plan = {"title": title, "subtitle": subtitle, "pages": pages, "scenes": scenes}
    validate_story_plan(plan, 6, 1)
    return plan


def plan_preview_story(vision: str, approved_preview: dict, total_scenes: int = 18) -> dict:
    """Plan only the six-scene opening from the AI story already saved by the app."""
    if total_scenes not in {18, 30}:
        raise ValueError("A preview must lead into an 18-scene or 30-scene movie.")
    return _preview_plan_from_saved_story(vision, approved_preview, total_scenes)


def plan_story(vision: str, approved_preview: dict, tier: str, opening_manifest: dict | None = None, total_scenes: int = SCENES) -> dict:
    """Complete the movie in six-scene chapters while preserving the purchased preview opening."""
    opening_manifest = opening_manifest or {}
    scenes = list(opening_manifest.get("scenes") or [])
    pages = list(opening_manifest.get("pages") or [])
    if total_scenes not in {18, 30}:
        raise ValueError("Paid movies must contain 18 or 30 scenes.")
    if len(scenes) not in {0, 6, total_scenes}:
        raise ValueError("A paid movie can start with zero scenes or the six locked preview scenes only.")
    if len(scenes) == total_scenes:
        validate_story_plan(opening_manifest,total_scenes)
        return opening_manifest
    title = str(opening_manifest.get("title") or "").strip()
    subtitle = str(opening_manifest.get("subtitle") or "").strip()
    for first_scene in range(len(scenes) + 1, total_scenes + 1, 6):
        last_scene = min(total_scenes, first_scene + 5)
        chapter = _plan_story_range(vision, approved_preview, tier, first_scene, last_scene, scenes,total_scenes)
        if not title:
            title = str(chapter.get("title") or "A Main Character Story")
        if not subtitle:
            subtitle = str(chapter.get("subtitle") or "A personalized moving story")
        scenes.extend(chapter["scenes"])
        pages.extend(chapter["pages"])
    plan = {"title": title, "subtitle": subtitle, "pages": pages, "scenes": scenes}
    validate_story_plan(plan,total_scenes)
    return plan


def _compact_prompt_value(value, limit: int) -> str:
    compact = " ".join(str(value or "").split())
    if len(compact) <= limit:
        return compact.rstrip(" ,.;")
    return compact[:limit].rsplit(" ", 1)[0].rstrip(" ,.;")


def locked_still_prompt(scene: dict) -> str:
    """Put identity, stylization, and scene truth inside Runway's hard 1,000-character limit."""
    identity = _compact_prompt_value(scene.get("identityLock"), 220)
    setting = _compact_prompt_value(scene.get("setting"), 65)
    action = _compact_prompt_value(scene.get("visibleAction") or scene.get("description"), 90)
    required = _compact_prompt_value(", ".join(scene.get("requiredVisibleDetails") or []), 80)
    supporting = _compact_prompt_value(", ".join(scene.get("supportingCharacters") or []), 30)
    prompt = (
        f"@Subject is the exact uploaded hero. IDENTITY LOCK: {identity}. "
        "STYLE LOCK: premium stylized animated-feature art: designed simplified forms, expressive eyes, painterly surfaces, illustrative texture, animation-rendered light. "
        "Never photorealistic, live action, camera-realistic, or realistic pet photography. "
        f"SCENE: {setting}. ACTION: {action}. MUST SHOW: {required}. SUPPORTING: {supporting or 'only those named in the scene'}. "
        "New 16:9 composition. Preserve exact build, colors, markings, face or muzzle, ears and tail. "
        "Bodies stay separate. No generic substitute, invented anatomy, source background, leash, text, logo, collage, or duplicate."
    )
    return prompt[:1000].rstrip()


def _runway_reference_image(
    reference_path: str,
    prompt: str,
    destination: str,
    on_task_created=None,
    existing_task_id: str | None = None,
) -> str:
    image = Path(reference_path).read_bytes()
    mime = "image/png" if reference_path.lower().endswith(".png") else "image/jpeg"
    reference_uri = f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"
    headers = {
        "Authorization": f"Bearer {os.environ['RUNWAY_API_KEY'].strip()}",
        "Content-Type": "application/json",
        "X-Runway-Version": "2024-11-06",
    }
    max_bad_output_retries = 2
    bad_output_retries = 0

    def create_task(retry_evidence: dict | None = None) -> str:
        response = requests.post(
            "https://api.dev.runwayml.com/v1/text_to_image",
            headers=headers,
            json={
                "model": "gen4_image_turbo",
                "ratio": "1280:720",
                "promptText": prompt[:1000],
                "referenceImages": [{"uri": reference_uri, "tag": "Subject"}],
            },
            timeout=60,
        )
        if not response.ok:
            raise RuntimeError(f"Runway reference-image request failed ({response.status_code}): {response.text[:500]}")
        created_task_id = str(response.json()["id"])
        if on_task_created:
            on_task_created(created_task_id, **(retry_evidence or {}))
        return created_task_id

    task_id = str(existing_task_id or "").strip() or create_task()
    deadline = time.monotonic() + 12 * 60
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Runway image task {task_id} exceeded the 12-minute scene limit.")
        task = requests.get(f"https://api.dev.runwayml.com/v1/tasks/{task_id}", headers=headers, timeout=30)
        task.raise_for_status()
        payload = task.json()
        if payload.get("status") == "SUCCEEDED":
            output_url = (payload.get("output") or [None])[0]
            if not output_url:
                raise RuntimeError("Runway completed an image without an output URL.")
            generated = requests.get(output_url, timeout=120)
            generated.raise_for_status()
            Path(destination).write_bytes(generated.content)
            _reject_reference_background(reference_path, destination)
            return destination
        if payload.get("status") in {"FAILED", "CANCELLED"}:
            failure_code = str(payload.get("failureCode") or "")
            credits = (payload.get("cost") or {}).get("credits")
            retryable_bad_output = (
                payload.get("status") == "FAILED"
                and failure_code.startswith("INTERNAL.BAD_OUTPUT.")
                and isinstance(credits, (int, float))
                and not isinstance(credits, bool)
                and credits == 0
            )
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
            # Preserve Runway's complete terminal response. The previous error
            # discarded failure, failureReason, failureCode, and error, leaving
            # production diagnosis with only the word "FAILED".
            runway_failure_payload = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":"), default=str
            )[:4000]
            raise RuntimeError(
                f"Runway image task {task_id} ended with {payload.get('status')}. "
                f"Full Runway response: {runway_failure_payload}"
            )
        time.sleep(3)


def illustrate(
    reference_path: str,
    scene: dict,
    destination: str,
    force_runway: bool = False,
    on_task_created=None,
    existing_task_id: str | None = None,
) -> str:
    prompt = locked_still_prompt(scene)
    if force_runway:
        return _runway_reference_image(
            reference_path,
            prompt,
            destination,
            on_task_created,
            existing_task_id=existing_task_id,
        )
    gateway_endpoint = os.environ.get("MCS_GATEWAY_IMAGE_ENDPOINT", "").strip()
    if gateway_endpoint:
        with open(reference_path, "rb") as image:
            response = _post_with_throttle_retry(
                gateway_endpoint,
                headers={"Authorization": f"Bearer {os.environ['MCS_WORKER_SECRET']}"},
                files={"image": ("reference.jpg", image, "image/jpeg")},
                data={"prompt": prompt},
                timeout=300,
            )
        response.raise_for_status()
        if not response.content:
            raise RuntimeError("Vercel AI Gateway returned no scene image.")
        Path(destination).write_bytes(response.content)
        _reject_reference_background(reference_path, destination)
        return destination
    with open(reference_path, "rb") as image:
        response = _post_with_throttle_retry("https://api.openai.com/v1/images/edits", headers=_auth(), files={"image": ("reference.jpg", image, "image/jpeg")}, data={
            "model": "gpt-image-2", "quality": "medium", "size": "1536x1024", "output_format": "png", "n": "1", "prompt": prompt,
        }, timeout=240)
    if response.status_code == 429:
        return _runway_reference_image(
            reference_path,
            prompt,
            destination,
            on_task_created,
            existing_task_id=existing_task_id,
        )
    response.raise_for_status()
    encoded = response.json().get("data", [{}])[0].get("b64_json")
    if not encoded:
        raise RuntimeError("OpenAI image generation returned no scene image.")
    Path(destination).write_bytes(base64.b64decode(encoded))
    _reject_reference_background(reference_path, destination)
    return destination


def narrate(text: str, destination: str) -> str:
    api_key = os.environ["ELEVENLABS_API_KEY"].strip()
    voice = os.environ["ELEVENLABS_VOICE_ID"].strip()
    model = os.environ.get("ELEVENLABS_MODEL_ID", ELEVENLABS_DEFAULT_MODEL).strip()
    if not api_key or not voice:
        raise RuntimeError("ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required for narration.")
    if model not in ELEVENLABS_ALLOWED_MODELS:
        raise RuntimeError("ELEVENLABS_MODEL_ID must be eleven_flash_v2_5 or eleven_turbo_v2_5; the higher-cost Multilingual v2 model is not enabled for this tier.")
    response = requests.post(
        f"{ELEVENLABS_TTS_ENDPOINT}/{voice}",
        headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        params={"output_format": "mp3_44100_128"},
        json={"text": text.strip(), "model_id": model, "voice_settings": {"stability": 0.55, "similarity_boost": 0.78, "style": 0.2, "use_speaker_boost": True, "speed": 1.05}},
        timeout=120,
    )
    if not response.ok or not response.content:
        openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not openai_key:
            response.raise_for_status()
            raise RuntimeError("ElevenLabs returned an empty narration file.")
        response = requests.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json", "Accept": "audio/mpeg"},
            json={"model": "gpt-4o-mini-tts", "voice": "marin", "input": text.strip(), "instructions": "Warm, natural professional storyteller. Clear human pacing and subtle emotional range; never robotic, rushed, sing-song, or theatrical."},
            timeout=120,
        )
        response.raise_for_status()
        if not response.content:
            raise RuntimeError("Both narration providers returned an empty audio file.")
    Path(destination).write_bytes(response.content)
    return destination


def sound_effect(scene: dict, destination: str, duration_seconds: float = 10.0) -> str:
    """Create one restrained diegetic ambience/action bed for a movie scene."""
    prompt = (
        f"Soft cinematic animated-storybook soundscape. Setting: {scene.get('setting', '')}. "
        f"Visible action: {scene.get('visibleAction', '')}. "
        f"Timed action: {'; '.join(str(value) for value in (scene.get('motionBeats') or []))}. "
        "Include only natural sounds caused by the setting and visible movement: wind, footsteps or paws, cloth or fur, water, props, weather, and gentle impacts as appropriate. "
        "No speech, narration, voices, melody, song, music, loud boom, trailer effect, or constant maximum volume. Keep it subtle beneath a woman narrator."
    )
    response = _post_with_throttle_retry(
        ELEVENLABS_SFX_ENDPOINT,
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"},
        params={"output_format": "mp3_44100_128"},
        json={
            "text": prompt[:500],
            "duration_seconds": max(0.5, min(30.0, duration_seconds)),
            "prompt_influence": 0.45,
            "model_id": "eleven_text_to_sound_v2",
        },
        timeout=180,
    )
    if response.status_code == 400:
        # A scene-specific phrase can occasionally trip the sound model's
        # request validator. Retry once with a short, neutral ambience brief;
        # sound polish must never destroy an otherwise valid customer movie.
        response = _post_with_throttle_retry(
            ELEVENLABS_SFX_ENDPOINT,
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"},
            params={"output_format": "mp3_44100_128"},
            json={
                "text": "Soft animated-storybook ambience with gentle wind, light movement, and subtle natural prop sounds. No speech, voices, music, melody, or loud impacts.",
                "duration_seconds": max(0.5, min(30.0, duration_seconds)),
                "prompt_influence": 0.35,
                "model_id": "eleven_text_to_sound_v2",
            },
            timeout=180,
        )
    if not response.ok or len(response.content) < 10_000:
        # Keep a restrained audible bed under narration even when the optional
        # provider rejects a scene. This is generated locally and spends no
        # additional provider credits.
        subprocess.run([
            "ffmpeg", "-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.018:sample_rate=44100",
            "-t", str(max(0.5, min(30.0, duration_seconds))), "-af", "lowpass=f=850,afade=t=in:st=0:d=0.4,afade=t=out:st=9.4:d=0.6",
            "-codec:a", "libmp3lame", "-b:a", "96k", destination,
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return destination
    Path(destination).write_bytes(response.content)
    return destination


def _wrapped_lines(text: str, font: str, size: float, max_width: float) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and stringWidth(candidate, font, size) > max_width:
            lines.append(current); current = word
        else: current = candidate
    if current: lines.append(current)
    return lines


def build_pdf(manifest: dict, image_paths: list[str], destination: str) -> str:
    width, height = landscape(letter)
    pdf = canvas.Canvas(destination, pagesize=(width, height))
    for index, (page, image_path) in enumerate(zip(manifest["pages"], image_paths), start=1):
        with Image.open(image_path) as image:
            image.thumbnail((width, height * 0.69))
            iw, ih = image.size
            pdf.drawImage(ImageReader(image), (width - iw) / 2, height - ih - 22, iw, ih, preserveAspectRatio=True, mask="auto")
        pdf.setFont("Helvetica-Bold", 11); pdf.setFillColorRGB(.45, .16, .5)
        pdf.drawString(36, 122, f"{manifest['title']} · Scene {index}")
        pdf.setFont("Times-Roman", 16); pdf.setFillColorRGB(.08, .12, .22)
        y = 96
        for line in _wrapped_lines(page["text"], "Times-Roman", 16, width - 72)[:4]:
            pdf.drawString(36, y, line); y -= 21
        pdf.showPage()
    pdf.save()
    return destination


def build_sequence(video_paths: list[str], audio_paths: list[str], workdir: str, destination: str, target_seconds: int, hard_audio_cuts: bool = False, sound_effect_paths: list[str] | None = None) -> str:
    _ensure_ffmpeg()
    if not video_paths or len(video_paths) != len(audio_paths):
        raise RuntimeError("A matching video and narration file is required for every scene.")
    if sound_effect_paths is not None and len(sound_effect_paths) != len(video_paths):
        raise RuntimeError("A matching sound-effects file is required for every scene when effects are enabled.")
    scene_count = len(video_paths)
    segment_seconds = (target_seconds + (scene_count - 1) * TRANSITION_SECONDS) / scene_count
    segments: list[str] = []
    for index, (video, audio) in enumerate(zip(video_paths, audio_paths), start=1):
        segment = str(Path(workdir) / f"segment-{index}.mp4")
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video],
            check=True, capture_output=True, text=True, timeout=30,
        )
        source_seconds = float(probe.stdout.strip())
        if source_seconds <= 0:
            raise RuntimeError(f"Scene {index} has no positive video duration.")
        speed_factor = segment_seconds / source_seconds
        audio_seconds = segment_seconds - TRANSITION_SECONDS if hard_audio_cuts and index < scene_count else segment_seconds
        command = ["ffmpeg", "-y", "-i", video, "-i", audio]
        if sound_effect_paths is not None:
            command += ["-i", sound_effect_paths[index - 1]]
            audio_filter = f"[1:a]apad,atrim=duration={audio_seconds},asetpts=PTS-STARTPTS[n];[2:a]volume=0.16,afade=t=in:st=0:d=0.35,afade=t=out:st={max(0.0, segment_seconds - 0.5)}:d=0.5,apad,atrim=duration={segment_seconds},asetpts=PTS-STARTPTS[fx];[n][fx]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]"
        else:
            audio_filter = f"[1:a]apad,atrim=duration={audio_seconds},asetpts=PTS-STARTPTS[a]"
        command += [
            "-filter_complex", f"[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setpts={speed_factor}*PTS,trim=duration={segment_seconds},fps=30,setpts=PTS-STARTPTS[v];{audio_filter}",
            "-map", "[v]", "-map", "[a]", "-t", str(segment_seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", segment,
        ]
        subprocess.run(command, check=True, timeout=240)
        segments.append(segment)
    # Do not build one enormous 18/30-input xfade graph. It retains every
    # decoded stream at once and can exhaust the serverless worker during the
    # final handoff even though every scene has already rendered successfully.
    # The segments above are normalized to identical H.264/AAC parameters, so
    # concatenate them incrementally with the demuxer. This is bounded-memory,
    # deterministic, and preserves every completed provider result.
    concat_file = Path(workdir) / "segments.txt"
    concat_file.write_text("\n".join(f"file '{Path(segment).name}'" for segment in segments), encoding="utf-8")
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-t", str(target_seconds), "-c", "copy", "-movflags", "+faststart", destination,
    ], check=True, timeout=1200, cwd=workdir)
    return destination


def build_movie(video_paths: list[str], audio_paths: list[str], workdir: str, destination: str, target_seconds: int = MOVIE_SECONDS, sound_effect_paths: list[str] | None = None) -> str:
    return build_sequence(video_paths, audio_paths, workdir, destination, target_seconds, sound_effect_paths=sound_effect_paths)


def verify_movie(path: str, target_seconds: int = MOVIE_SECONDS) -> None:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,duration", "-of", "json", path],
        check=True, capture_output=True, text=True, timeout=30,
    )
    payload = json.loads(result.stdout)
    duration = float(payload.get("format", {}).get("duration") or 0)
    streams = payload.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not target_seconds - 0.5 <= duration <= target_seconds + 0.5:
        raise RuntimeError(f"Final movie duration is {duration:.3f}s; expected {target_seconds} seconds.")
    if video is None or video.get("codec_name") != "h264":
        raise RuntimeError("Final movie is missing its H.264 video stream.")
    if audio is None or audio.get("codec_name") != "aac":
        raise RuntimeError("Final movie is missing its AAC narration stream.")
