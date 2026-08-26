import crypto from 'crypto';
import {runpod} from './_runpod';

const EXPECTED_TOKEN_HASH='045e395bb22805e988f282db8e5042504fabfa841f60c7c549316831bb19cd33';
const TEMPLATE_ID='2w5x8empgg';
const ENDPOINT_ID='id81aby9nfth9h';
const HANDLER_COMMIT='94cff6681dcb9ddb070d0dd55d783a44e4de1be7';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function authorized(req){
  const supplied=String(req.headers['x-mcs-admin-token']||req.query?.token||'');
  const actual=crypto.createHash('sha256').update(supplied).digest('hex');
  try{
    const left=Buffer.from(actual,'hex');
    const right=Buffer.from(EXPECTED_TOKEN_HASH,'hex');
    return left.length===right.length&&crypto.timingSafeEqual(left,right);
  }catch{return false}
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});

  const{key}=runpod();
  if(!key)return res.status(503).json({error:'RunPod key missing'});
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};

  try{
    const lookup=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{headers});
    const template=await lookup.json();
    if(!lookup.ok)return res.status(lookup.status).json({error:'Template lookup failed'});

    let cmd=String((template.dockerStartCmd||[])[0]||'');
    const handlerUrl=`https://raw.githubusercontent.com/debeaux13-cloud/cajun-country/${HANDLER_COMMIT}/worker/handler.py`;
    const pinned=/https:\/\/raw\.githubusercontent\.com\/debeaux13-cloud\/cajun-country\/[0-9a-f]{40}\/worker\/handler\.py/g;
    if(cmd.match(pinned))cmd=cmd.replace(pinned,handlerUrl);
    else{
      const marker='export PYTHONPATH="/opt/mcs-bundle:${PYTHONPATH:-}"';
      const download=`python -c "import urllib.request; urllib.request.urlretrieve('${handlerUrl}','/opt/mcs-bundle/handler.py')"; `;
      if(!cmd.includes(marker))return res.status(409).json({error:'Safe worker insertion point missing'});
      cmd=cmd.replace(marker,download+marker);
    }
    if(!cmd.includes(handlerUrl))return res.status(409).json({error:'Versioned handler pin was not applied'});

    const body={
      containerDiskInGb:template.containerDiskInGb,
      containerRegistryAuthId:template.containerRegistryAuthId||undefined,
      dockerEntrypoint:template.dockerEntrypoint||[],
      dockerStartCmd:[cmd],
      env:template.env||{},
      imageName:template.imageName,
      isPublic:!!template.isPublic,
      name:template.name,
      ports:template.ports||[],
      readme:template.readme||'',
      volumeInGb:template.volumeInGb||0,
      volumeMountPath:template.volumeMountPath||'/workspace'
    };
    Object.keys(body).forEach(name=>body[name]===undefined&&delete body[name]);

    const patch=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{method:'PATCH',headers,body:JSON.stringify(body)});
    const templateResult=await patch.json().catch(()=>({}));
    if(!patch.ok)return res.status(patch.status).json({error:'Template patch failed',detail:templateResult});

    const down=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});
    if(!down.ok)return res.status(down.status).json({error:'Worker scale-down failed'});
    await sleep(2500);
    const up=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})});
    const endpoint=await up.json().catch(()=>({}));
    if(!up.ok)return res.status(up.status).json({error:'Worker scale-up failed',detail:endpoint});

    return res.status(200).json({
      ok:true,
      templateId:TEMPLATE_ID,
      endpointId:ENDPOINT_ID,
      handlerCommit:HANDLER_COMMIT,
      recycled:true,
      endpointVersion:endpoint.version??null,
      workersMax:endpoint.workersMax??4
    });
  }catch(error){
    return res.status(502).json({error:error.message});
  }
}
