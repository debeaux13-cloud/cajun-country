"""MCS Tier-1 worker: $49 / 3 minutes / 18 scenes."""
from __future__ import annotations
import os, tempfile, time, uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests, runpod
from pipeline_steps import build_movie, build_pdf, illustrate, narrate, sound_effect, validate_story_plan, validate_unique_scene_images, verify_movie, verify_obvious_clip_motion
from runway_adapter import RunwayGen4Turbo

BUNDLE_VERSION="2026-08-26-mcs-v15-server-blob-motion-retry"

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
        return {"status":"ready","bundleVersion":BUNDLE_VERSION,"product":"$49 / 3 minutes / 18 scenes","previewScenes":6,"paidContinuationScenes":12,"directBlobUploads":True,"soundEffects":True,"backgroundMusic":True,"weakMotionRetry":1}
    if payload.get("workerSecret"):os.environ["MCS_WORKER_SECRET"]=str(payload["workerSecret"])
    job_id=str(payload.get("jobId") or "").strip(); mode=str(payload.get("mode") or "paid").strip(); callback=str(payload.get("callbackBase") or "").rstrip("/")
    if not job_id or not callback: raise ValueError("jobId and callbackBase are required")
    preview=mode in {"preview","preview_sound_resume"}
    job_url=f"{callback}/api/internal/{'preview-pipeline' if preview else 'pipeline/jobs'}/{job_id}"
    r=requests.get(job_url,headers=auth_headers(),timeout=30); r.raise_for_status(); job=r.json()
    p=job.get("providers") or {}
    for env,key in [("AI_GATEWAY_API_KEY","aiGatewayApiKey"),("OPENAI_API_KEY","openaiApiKey"),("RUNWAY_API_KEY","runwayApiKey"),("ELEVENLABS_API_KEY","elevenLabsApiKey"),("ELEVENLABS_VOICE_ID","elevenLabsVoiceId"),("ELEVENLABS_MODEL_ID","elevenLabsModelId")]: os.environ[env]=str(p.get(key) or ("eleven_flash_v2_5" if env=="ELEVENLABS_MODEL_ID" else ""))
    for n in ("RUNWAY_API_KEY","ELEVENLABS_API_KEY","ELEVENLABS_VOICE_ID"):req(n)
    contract=job.get("contract") or {}
    if contract.get("petRouting")!="runway-gen4-turbo-only" or contract.get("animalPoseDetection") is not False: raise ValueError("Invalid MCS motion contract")
    scene_count=int(contract.get("scenes") or (6 if preview else 18)); movie_seconds=int(contract.get("movieSeconds") or (60 if preview else 180))

    def update(stage,scene=0,status="running",**extra):
        b={"stage":stage,"status":status,**extra}
        if scene:b["scene"]=scene
        x=requests.patch(job_url,headers=auth_headers("application/json"),json=b,timeout=30); x.raise_for_status(); return x.json()

    def upload(kind,path,scene=0,content_type="application/octet-stream"):
        data=Path(path).read_bytes(); ticket_url=f"{callback}/api/internal/pipeline/jobs/{job_id}/upload-ticket"
        t=requests.post(ticket_url,headers=auth_headers("application/json"),json={"kind":kind,"scene":scene or "","contentType":content_type,"size":len(data)},timeout=30); t.raise_for_status(); info=t.json()
        if info.get("mode")!="server": raise RuntimeError(f"Blob ticket mode invalid: {info}")
        pathname=str(info["pathname"]); api=str(info["apiUrl"]).rstrip("/")+"/?pathname="+requests.utils.quote(pathname,safe="")
        store=str(info["storeId"]); token=str(info["token"])
        headers={"authorization":f"Bearer {token}","x-vercel-blob-store-id":store,"x-api-version":"12","x-api-blob-request-id":f"{store}:{int(time.time()*1000)}:{uuid.uuid4().hex[:12]}","x-api-blob-request-attempt":"0","x-vercel-blob-access":"private","x-content-type":content_type,"x-add-random-suffix":"0","x-allow-overwrite":"1"}
        sent=requests.put(api,headers=headers,data=data,timeout=600)
        if not sent.ok: raise RuntimeError(f"Blob upload failed {sent.status_code}: {sent.text[:600]}")

    def download(kind,dest,scene=0):
        url=f"{job['assets']['previewScene']}?kind={kind}"+(f"&scene={scene}" if scene else "")
        x=requests.get(url,headers=auth_headers(),timeout=180); x.raise_for_status(); Path(dest).write_bytes(x.content)

    def render_scene(root,reference,scene,index):
        n=int(scene["sceneNumber"]); image=str(root/f"scene-{n}.png"); narration=str(root/f"narration-{n}.mp3"); sfx=str(root/f"sound-{n}.mp3"); video=str(root/f"scene-{n}.mp4")
        illustrate(str(reference),scene,image,True,on_task_created=lambda task_id,**retry:update("illustrating",n,"provider_started",provider="runway-gen4-image-turbo",providerJobId=task_id,**retry)); upload("scene-image",image,n,"image/png"); update("illustrating",n,"illustrated")
        narrate(str(scene["narration"]),narration); upload("narration",narration,n,"audio/mpeg"); update("narrating",n,"narrated")
        sound_effect(scene,sfx); upload("sound-effect",sfx,n,"audio/mpeg"); update("sound",n,"ready")
        runway=RunwayGen4Turbo(req("RUNWAY_API_KEY"),10); base_prompt=str(scene.get("visibleAction") or scene.get("description") or scene.get("narration") or "")
        existing=(job.get("existingProviderJobs") or {}).get(str(n)) or {}
        _,provider_job_id=runway.animate(image,video,base_prompt,existing_task_id=str(existing.get("providerJobId") or "") or None,on_task_created=lambda task_id,**retry:update("animating",n,"provider_started",provider="runway-gen4-turbo",providerJobId=task_id,**retry))
        try: verify_obvious_clip_motion(video)
        except Exception as first:
            update("animating",n,"motion_retry",error=str(first))
            retry_prompt=base_prompt+" IMPORTANT: the main character must visibly move their whole body across the frame, change position, react, and physically interact with the scene. Do not use scenery-only motion or a mostly static pose."
            _,provider_job_id=runway.animate(image,video,retry_prompt,existing_task_id=None,on_task_created=lambda task_id,**retry:update("animating",n,"provider_started",provider="runway-gen4-turbo-motion-retry",providerJobId=task_id,**retry))
            verify_obvious_clip_motion(video)
        upload("scene-video",video,n,"video/mp4"); update("animating",n,"animated",providerJobId=provider_job_id); runpod.serverless.progress_update(event,f"Scene {index} finished")
        return image,narration,sfx,video

    try:
        with tempfile.TemporaryDirectory(prefix=f"mcs-{mode}-{job_id}-") as folder:
            root=Path(folder); reference=root/"reference.jpg"; src=requests.get(job["assets"]["reference"],headers=auth_headers(),timeout=60); src.raise_for_status(); reference.write_bytes(src.content)
            manifest=job.get("existingManifest") or {}; validate_story_plan(manifest,6 if preview else scene_count,1 if preview else None); scenes=list(manifest.get("scenes") or [])
            if preview:
                rendered=[None]*6
                with ThreadPoolExecutor(max_workers=6) as ex:
                    fut={ex.submit(render_scene,root,reference,s,i):i-1 for i,s in enumerate(scenes,start=1)}
                    for f in as_completed(fut):rendered[fut[f]]=f.result()
                images=[x[0] for x in rendered]; narr=[x[1] for x in rendered]; sounds=[x[2] for x in rendered]; vids=[x[3] for x in rendered]; validate_unique_scene_images(images)
                update("assembling"); movie=str(root/"preview.mp4"); build_movie(vids,narr,folder,movie,60,sound_effect_paths=sounds); verify_movie(movie,60); upload("preview-movie",movie,content_type="video/mp4"); update("ready",status="ready",manifest=manifest)
                return {"jobId":job_id,"status":"ready","mode":mode,"completed":6}
            if scene_count!=18 or movie_seconds!=180: raise ValueError("Live product must be 18 scenes / 180 seconds")
            rendered=[None]*18
            for i,s in enumerate(scenes[:6],start=1):
                n=int(s["sceneNumber"]); vals=[]
                for kind,ext in [("scene-image","png"),("narration","mp3"),("sound-effect","mp3"),("scene-video","mp4")]:
                    path=str(root/f"{kind}-{n}.{ext}"); download(kind,path,n); vals.append(path)
                rendered[i-1]=tuple(vals)
            with ThreadPoolExecutor(max_workers=6) as ex:
                fut={ex.submit(render_scene,root,reference,s,i):i-1 for i,s in enumerate(scenes[6:],start=7)}
                for f in as_completed(fut):rendered[fut[f]]=f.result()
            images=[x[0] for x in rendered]; narr=[x[1] for x in rendered]; sounds=[x[2] for x in rendered]; vids=[x[3] for x in rendered]; validate_unique_scene_images(images)
            update("assembling"); movie=str(root/"story-video.mp4"); build_movie(vids,narr,folder,movie,180,sound_effect_paths=sounds); verify_movie(movie,180); upload("final-movie",movie,content_type="video/mp4")
            update("verifying"); pdf=str(root/"storybook.pdf"); build_pdf(manifest,images,pdf); upload("storybook-pdf",pdf,content_type="application/pdf"); update("ready",status="ready",manifest=manifest)
            return {"jobId":job_id,"status":"ready","tier":"three_minute","completed":18,"movieSeconds":180}
    except Exception as e:
        try:update("manual_review",status="failed",error=str(e))
        except Exception:pass
        return {"jobId":job_id,"status":"manual_review","mode":mode,"error":str(e)}

if __name__=="__main__": runpod.serverless.start({"handler":handler})
