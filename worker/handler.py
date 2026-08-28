"""MCS Tier-1 worker: $49 / 3 minutes / 18 scenes."""
from __future__ import annotations
import os, tempfile, time, uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests, runpod
from audio_polish import add_background_music, create_background_music, normalize_music_vibe
from pipeline_steps import build_movie, build_pdf, create_character_master, illustrate, locked_motion_scene_prompt, narrate, sound_effect, validate_story_plan, validate_unique_scene_images, verify_movie, verify_obvious_clip_motion
from runway_adapter import RunwayGen4Turbo

BUNDLE_VERSION="2026-08-27-mcs-v20-canonical-character-master"

def req(name):
    v=os.environ.get(name,"").strip()
    if not v: raise RuntimeError(f"Missing worker setting: {name}")
    return v

def auth_headers(content_type=None):
    h={"Authorization":f"Bearer {req('MCS_WORKER_SECRET')}"}
    if content_type:h["Content-Type"]=content_type
    return h

def handler(event):
    payload=event.get("input") or event
    if str(payload.get("action") or "")=="version":
        return {"status":"ready","bundleVersion":BUNDLE_VERSION,"product":"$49 / 3 minutes / 18 scenes","previewScenes":6,"paidContinuationScenes":12,"directBlobUploads":True,"soundEffects":True,"backgroundMusic":True,"vibeAwareMusic":True,"previewMusicContinuity":True,"weakMotionRetry":1,"exactSceneRuntime":True,"narrationEndProtection":True,"maxReferenceSubjects":12}
    if payload.get("workerSecret"):os.environ["MCS_WORKER_SECRET"]=str(payload["workerSecret"])
    job_id=str(payload.get("jobId") or "").strip(); mode=str(payload.get("mode") or "paid").strip(); callback=str(payload.get("callbackBase") or "").rstrip("/")
    identity_override=str(payload.get("identityOverride") or "").strip()
    if not job_id or not callback: raise ValueError("jobId and callbackBase are required")
    identity_probe=mode=="identity_probe"
    preview=mode in {"preview","preview_sound_resume","identity_probe"}
    job_url=f"{callback}/api/internal/{'preview-pipeline' if preview else 'pipeline/jobs'}/{job_id}"
    r=requests.get(job_url,headers=auth_headers(),timeout=30); r.raise_for_status(); job=r.json()
    p=job.get("providers") or {}
    for env,key in [("AI_GATEWAY_API_KEY","aiGatewayApiKey"),("OPENAI_API_KEY","openaiApiKey"),("RUNWAY_API_KEY","runwayApiKey"),("ELEVENLABS_API_KEY","elevenLabsApiKey"),("ELEVENLABS_VOICE_ID","elevenLabsVoiceId"),("ELEVENLABS_MODEL_ID","elevenLabsModelId")]: os.environ[env]=str(p.get(key) or ("eleven_flash_v2_5" if env=="ELEVENLABS_MODEL_ID" else ""))
    for n in ("RUNWAY_API_KEY","ELEVENLABS_API_KEY","ELEVENLABS_VOICE_ID"):req(n)
    contract=job.get("contract") or {}
    if contract.get("petRouting")!="runway-gen4-turbo-only" or contract.get("animalPoseDetection") is not False: raise ValueError("Invalid MCS motion contract")
    scene_count=int(contract.get("scenes") or (6 if preview else 18)); movie_seconds=int(contract.get("movieSeconds") or (60 if preview else 180))
    moods=job.get("moods") if isinstance(job.get("moods"),list) else []
    selected_vibe=normalize_music_vibe(job.get("selectedVibe") or contract.get("musicVibe") or (moods[0] if moods else "surprise me"))

    def update(stage,scene=0,status="running",**extra):
        b={"stage":stage,"status":status,**extra}
        if scene:b["scene"]=scene
        x=requests.patch(job_url,headers=auth_headers("application/json"),json=b,timeout=30); x.raise_for_status(); return x.json()

    def upload(kind,path,scene=0,content_type="application/octet-stream"):
        data=Path(path).read_bytes()
        asset_url=f"{job['assets']['upload']}?kind={requests.utils.quote(str(kind),safe='')}"+(f"&scene={int(scene)}" if scene else "")
        sent=requests.put(asset_url,headers=auth_headers(content_type),data=data,timeout=600)
        if not sent.ok: raise RuntimeError(f"Blob artifact upload failed {sent.status_code}: {sent.text[:600]}")

    def download(kind,dest,scene=0):
        url=f"{job['assets']['previewScene']}?kind={kind}"+(f"&scene={scene}" if scene else "")
        x=requests.get(url,headers=auth_headers(),timeout=180); x.raise_for_status(); Path(dest).write_bytes(x.content)

    def download_if_present(kind,dest,scene=0):
        url=f"{job['assets']['previewScene']}?kind={kind}"+(f"&scene={scene}" if scene else "")
        x=requests.get(url,headers=auth_headers(),timeout=180)
        if x.status_code==404:return False
        x.raise_for_status()
        if not x.content:return False
        Path(dest).write_bytes(x.content)
        return True

    def checkpoint_provider(stage,scene,provider,task_id,**retry):
        task_id=str(task_id or "").strip()
        if not task_id or task_id=="motion-quality-rerender":return None
        last_error=None
        for attempt in range(3):
            try:
                return update(stage,scene,"provider_started",provider=provider,providerJobId=task_id,**retry)
            except Exception as error:
                last_error=error
                time.sleep(1+attempt)
        raise RuntimeError(f"Provider task checkpoint failed for {task_id}: {last_error}")

    def render_scene(root,reference,scene,index):
        n=int(scene["sceneNumber"]); image=str(root/f"scene-{n}.png"); narration=str(root/f"narration-{n}.mp3"); sfx=str(root/f"sound-{n}.mp3"); video=str(root/f"scene-{n}.mp4")
        existing=(job.get("existingProviderJobs") or {}).get(str(n)) or {}
        image_task={"id":str(existing.get("imageProviderJobId") or "")}
        if not download_if_present("scene-image",image,n):
            try:
                illustrate(
                    str(reference),scene,image,True,
                    existing_task_id=image_task["id"] or None,
                    on_task_created=lambda task_id,**retry:(
                        image_task.update(id=str(task_id)),
                        checkpoint_provider("illustrating",n,"runway-gen4-image-turbo",task_id,**retry)
                    )[-1]
                )
            except Exception:
                if image_task["id"]:
                    try:update("illustrating",n,"provider_failed",provider="runway-gen4-image-turbo",providerJobId=image_task["id"])
                    except Exception:pass
                raise
            upload("scene-image",image,n,"image/png")
        update("illustrating",n,"illustrated",provider="runway-gen4-image-turbo",providerJobId=image_task["id"])
        if not download_if_present("narration",narration,n):
            narrate(str(scene["narration"]),narration); upload("narration",narration,n,"audio/mpeg")
        update("narrating",n,"narrated")
        if not download_if_present("sound-effect",sfx,n):
            sound_effect(scene,sfx); upload("sound-effect",sfx,n,"audio/mpeg")
        update("sound",n,"ready")
        if download_if_present("scene-video",video,n):
            try:
                verify_obvious_clip_motion(video)
                update("animating",n,"animated",provider="runway-gen4-turbo",providerJobId=str(existing.get("animationProviderJobId") or existing.get("providerJobId") or ""))
                runpod.serverless.progress_update(event,f"Scene {index} reused")
                return image,narration,sfx,video
            except Exception:
                Path(video).unlink(missing_ok=True)
        runway=RunwayGen4Turbo(req("RUNWAY_API_KEY"),10); base_prompt=locked_motion_scene_prompt(scene)
        animation_task={"id":str(existing.get("animationProviderJobId") or existing.get("providerJobId") or "")}
        def animation_started(task_id,provider="runway-gen4-turbo",**retry):
            if str(task_id)=="motion-quality-rerender":return None
            animation_task["id"]=str(task_id)
            return checkpoint_provider("animating",n,provider,task_id,**retry)
        try:
            _,provider_job_id=runway.animate(
                image,video,base_prompt,
                existing_task_id=animation_task["id"] or None,
                on_task_created=lambda task_id,**retry:animation_started(task_id,**retry)
            )
            try:verify_obvious_clip_motion(video)
            except Exception as first:
                update("animating",n,"motion_retry",error=str(first))
                retry_prompt="STRONG FULL-BODY MOTION RETRY: hero visibly changes position, reacts, and interacts; no scenery-only motion or static pose. "+base_prompt
                _,provider_job_id=runway.animate(
                    image,video,retry_prompt,
                    existing_task_id=None,
                    on_task_created=lambda task_id,**retry:animation_started(task_id,provider="runway-gen4-turbo-motion-retry",**retry)
                )
                verify_obvious_clip_motion(video)
        except Exception as error:
            if animation_task["id"]:
                try:update("animating",n,"provider_failed",provider="runway-gen4-turbo",providerJobId=animation_task["id"],error=str(error)[:1200])
                except Exception:pass
            raise
        upload("scene-video",video,n,"video/mp4"); update("animating",n,"animated",provider="runway-gen4-turbo",providerJobId=provider_job_id); runpod.serverless.progress_update(event,f"Scene {index} finished")
        return image,narration,sfx,video

    try:
        with tempfile.TemporaryDirectory(prefix=f"mcs-{mode}-{job_id}-") as folder:
            root=Path(folder); reference=root/"reference.jpg"; src=requests.get(job["assets"]["reference"],headers=auth_headers(),timeout=60); src.raise_for_status(); reference.write_bytes(src.content)
            manifest=job.get("existingManifest") or {}; validate_story_plan(manifest,6 if preview else scene_count,1); scenes=list(manifest.get("scenes") or [])
            if identity_probe:
                scene=dict(scenes[0])
                if identity_override:
                    scene["identityLock"]=(identity_override+" "+str(scene.get("identityLock") or "")).strip()
                n=int(scene["sceneNumber"]); image=str(root/f"identity-probe-{n}.png"); image_task={"id":""}
                illustrate(
                    str(reference),scene,image,True,
                    on_task_created=lambda task_id,**retry:(
                        image_task.update(id=str(task_id)),
                        checkpoint_provider("illustrating",n,"runway-gen4-image-turbo",task_id,**retry)
                    )[-1]
                )
                upload("identity-probe",image,content_type="image/png")
                update("identity_probe",n,"ready",provider="runway-gen4-image-turbo",providerJobId=image_task["id"])
                return {"jobId":job_id,"status":"ready","mode":mode,"completed":1,"identityProbe":True}
            master=root/"character-master.png"
            master_reused=download_if_present("character-master",str(master))
            if not master_reused:
                master_task={"id":""}
                update("character_master")
                create_character_master(
                    str(reference),str(scenes[0].get("identityLock") or ""),str(master),
                    on_task_created=lambda task_id,**retry:(
                        master_task.update(id=str(task_id)),
                        checkpoint_provider("character_master",0,"runway-gen4-image-turbo",task_id,**retry)
                    )[-1]
                )
                upload("character-master",str(master),content_type="image/png")
                update("character_master",status="ready",provider="runway-gen4-image-turbo",providerJobId=master_task["id"])
            if preview:
                rendered=[None]*6
                with ThreadPoolExecutor(max_workers=5) as ex:
                    fut={ex.submit(render_scene,root,master,s,i):i-1 for i,s in enumerate(scenes,start=1)}
                    for f in as_completed(fut):rendered[fut[f]]=f.result()
                images=[x[0] for x in rendered]; narr=[x[1] for x in rendered]; sounds=[x[2] for x in rendered]; vids=[x[3] for x in rendered]; validate_unique_scene_images(images)
                update("assembling"); movie=str(root/"preview.mp4"); music=str(root/"preview-music-bed.mp3"); build_movie(vids,narr,folder,movie,60,sound_effect_paths=sounds); create_background_music(music,selected_vibe,30); upload("music-bed",music,content_type="audio/mpeg"); add_background_music(movie,folder,60,music_path=music,vibe=selected_vibe); verify_movie(movie,60); upload("preview-movie",movie,content_type="video/mp4"); update("ready",status="ready",manifest=manifest,musicVibe=selected_vibe,musicAsset="music-bed")
                return {"jobId":job_id,"status":"ready","mode":mode,"completed":6,"musicVibe":selected_vibe,"musicContinuity":True}
            if scene_count!=18 or movie_seconds!=180: raise ValueError("Live product must be 18 scenes / 180 seconds")
            rendered=[None]*18
            for i,s in enumerate(scenes[:6],start=1):
                n=int(s["sceneNumber"]); vals=[]
                for kind,ext in [("scene-image","png"),("narration","mp3"),("sound-effect","mp3"),("scene-video","mp4")]:
                    path=str(root/f"{kind}-{n}.{ext}"); download(kind,path,n); vals.append(path)
                rendered[i-1]=tuple(vals)
            with ThreadPoolExecutor(max_workers=6) as ex:
                fut={ex.submit(render_scene,root,master,s,i):i-1 for i,s in enumerate(scenes[6:],start=7)}
                for f in as_completed(fut):rendered[fut[f]]=f.result()
            images=[x[0] for x in rendered]; narr=[x[1] for x in rendered]; sounds=[x[2] for x in rendered]; vids=[x[3] for x in rendered]; validate_unique_scene_images(images)
            update("assembling"); movie=str(root/"story-video.mp4"); music=str(root/"preview-music-bed.mp3"); build_movie(vids,narr,folder,movie,180,sound_effect_paths=sounds); music_continuity=download_if_present("music-bed",music)
            if not music_continuity:
                create_background_music(music,selected_vibe,30,allow_provider=False)
            add_background_music(movie,folder,180,music_path=music,vibe=selected_vibe); verify_movie(movie,180); upload("final-movie",movie,content_type="video/mp4")
            update("verifying"); pdf=str(root/"storybook.pdf"); build_pdf(manifest,images,pdf); upload("storybook-pdf",pdf,content_type="application/pdf"); update("ready",status="ready",manifest=manifest)
            return {"jobId":job_id,"status":"ready","tier":"three_minute","completed":18,"movieSeconds":180,"musicVibe":selected_vibe,"musicContinuity":music_continuity}
    except Exception as e:
        try:update("manual_review",status="failed",error=str(e))
        except Exception:pass
        return {"jobId":job_id,"status":"manual_review","mode":mode,"error":str(e)}

if __name__=="__main__": runpod.serverless.start({"handler":handler})
