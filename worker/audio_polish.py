from __future__ import annotations
import os, subprocess
from pathlib import Path
import requests

ELEVENLABS_SFX_ENDPOINT='https://api.elevenlabs.io/v1/sound-generation'

def _music_bed(destination: str, duration: float = 30.0) -> str:
    duration=max(10.0,min(30.0,float(duration)))
    key=os.environ.get('ELEVENLABS_API_KEY','').strip()
    if key:
        try:
            r=requests.post(ELEVENLABS_SFX_ENDPOINT,headers={'xi-api-key':key,'Content-Type':'application/json'},params={'output_format':'mp3_44100_128'},json={'text':'Gentle cinematic instrumental underscore for a heartfelt animated family story. Soft warm piano, light strings and airy pads, simple unobtrusive harmony. No vocals, no speech, no trailer hits, no heavy percussion. Designed to sit very quietly beneath narration and natural scene sound effects.','duration_seconds':duration,'prompt_influence':0.35,'model_id':'eleven_text_to_sound_v2'},timeout=180)
            if r.ok and len(r.content)>10000:
                Path(destination).write_bytes(r.content);return destination
        except Exception:
            pass
    subprocess.run(['ffmpeg','-y','-f','lavfi','-i','sine=frequency=220:sample_rate=44100','-f','lavfi','-i','sine=frequency=277.18:sample_rate=44100','-f','lavfi','-i','sine=frequency=329.63:sample_rate=44100','-filter_complex','[0:a]volume=0.025[a0];[1:a]volume=0.018[a1];[2:a]volume=0.016[a2];[a0][a1][a2]amix=inputs=3:normalize=0,lowpass=f=1200,afade=t=in:st=0:d=2,afade=t=out:st=27:d=3[a]','-map','[a]','-t',str(duration),'-codec:a','libmp3lame','-b:a','96k',destination],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    return destination

def add_background_music(movie_path: str, workdir: str, target_seconds: int) -> str:
    music=str(Path(workdir)/'mcs-background-music.mp3')
    _music_bed(music,30)
    polished=str(Path(workdir)/(Path(movie_path).stem+'-polished.mp4'))
    subprocess.run(['ffmpeg','-y','-i',movie_path,'-stream_loop','-1','-i',music,'-filter_complex',f'[0:a]volume=1.0[main];[1:a]volume=0.055,afade=t=in:st=0:d=2,afade=t=out:st={max(0,target_seconds-3)}:d=3,atrim=duration={target_seconds}[music];[main][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]','-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-t',str(target_seconds),'-movflags','+faststart',polished],check=True,timeout=1200)
    Path(movie_path).write_bytes(Path(polished).read_bytes())
    return movie_path
