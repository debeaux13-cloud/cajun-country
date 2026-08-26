from __future__ import annotations
import os
from pathlib import Path
import requests

ELEVENLABS_TTS_ENDPOINT='https://api.elevenlabs.io/v1/text-to-speech'
MCS_TTS_ENDPOINT='https://main-character-studios.vercel.app/api/internal/tts'

def narrate(text:str,destination:str)->str:
    text=str(text or '').strip()
    if not text:
        raise RuntimeError('Narration text is empty.')
    key=os.environ.get('ELEVENLABS_API_KEY','').strip()
    voice=os.environ.get('ELEVENLABS_VOICE_ID','').strip()
    model=os.environ.get('ELEVENLABS_MODEL_ID','eleven_flash_v2_5').strip() or 'eleven_flash_v2_5'
    if key and voice:
        try:
            r=requests.post(f'{ELEVENLABS_TTS_ENDPOINT}/{voice}',headers={'xi-api-key':key,'Content-Type':'application/json','Accept':'audio/mpeg'},params={'output_format':'mp3_44100_128'},json={'text':text,'model_id':model,'voice_settings':{'stability':0.55,'similarity_boost':0.78,'style':0.2,'use_speaker_boost':True,'speed':1.05}},timeout=120)
            if r.ok and r.content:
                Path(destination).write_bytes(r.content)
                return destination
        except Exception:
            pass
    secret=os.environ.get('MCS_WORKER_SECRET','').strip()
    if not secret:
        raise RuntimeError('Narration fallback missing MCS_WORKER_SECRET.')
    r=requests.post(MCS_TTS_ENDPOINT,headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json','Accept':'audio/mpeg'},json={'text':text},timeout=120)
    if not r.ok or not r.content:
        raise RuntimeError(f'AI Gateway narration fallback failed ({r.status_code}): {r.text[:300]}')
    Path(destination).write_bytes(r.content)
    return destination
