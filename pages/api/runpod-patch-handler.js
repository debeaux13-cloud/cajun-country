import { runpod } from './_runpod';

export default async function handler(req, res) {
  const { key } = runpod();
  const id = '2w5x8empgg';
  if (!key) return res.status(503).json({ error: 'RunPod key missing' });

  try {
    const lookup = await fetch(`https://rest.runpod.io/v1/templates/${id}`, {
      headers: { Authorization: 'Bearer ' + key },
    });
    const template = await lookup.json();
    if (!lookup.ok) return res.status(lookup.status).json({ error: 'template lookup failed' });

    let cmd = (template.dockerStartCmd || [])[0] || '';
    cmd = cmd.replace("('handler.py','audio_polish.py','sitecustomize.py')", "('audio_polish.py','sitecustomize.py')");
    cmd = cmd.replace(
      'export PYTHONPATH="/opt/mcs-bundle:$PYTHONPATH"',
      'export PYTHONPATH="/opt/mcs-bundle:${PYTHONPATH:-}"'
    );

    const marker = 'export PYTHONPATH="/opt/mcs-bundle:${PYTHONPATH:-}"';
    const handlerPin = 'ba77d197fc3e636baa3f6769b17f4160bdccf0d3/worker/handler.py';
    const pipelinePin = '5abd971895287e8e48c7990390dba48187c93e34/worker/pipeline_steps.py';
    const handlerDownload =
      'python -c "import urllib.request; urllib.request.urlretrieve(\'https://raw.githubusercontent.com/debeaux13-cloud/cajun-country/' +
      handlerPin +
      '\',\'/opt/mcs-bundle/handler.py\')"\; ';
    const pipelineDownload =
      'python -c "import urllib.request; urllib.request.urlretrieve(\'https://raw.githubusercontent.com/debeaux13-cloud/cajun-country/' +
      pipelinePin +
      '\',\'/opt/mcs-bundle/pipeline_steps.py\')"\; ';

    if (!cmd.includes(marker)) {
      return res.status(409).json({ error: 'safe PYTHONPATH marker missing' });
    }
    if (!cmd.includes(handlerPin)) cmd = cmd.replace(marker, handlerDownload + marker);
    if (!cmd.includes(pipelinePin)) cmd = cmd.replace(marker, pipelineDownload + marker);

    const body = {
      containerDiskInGb: template.containerDiskInGb,
      containerRegistryAuthId: template.containerRegistryAuthId || undefined,
      dockerEntrypoint: template.dockerEntrypoint || [],
      dockerStartCmd: [cmd],
      env: template.env || {},
      imageName: template.imageName,
      isPublic: !!template.isPublic,
      name: template.name,
      ports: template.ports || [],
      readme: template.readme || '',
      volumeInGb: template.volumeInGb || 0,
      volumeMountPath: template.volumeMountPath || '/workspace',
    };
    Object.keys(body).forEach((keyName) => body[keyName] === undefined && delete body[keyName]);

    const patch = await fetch(`https://rest.runpod.io/v1/templates/${id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await patch.json().catch(() => ({}));
    if (!patch.ok) return res.status(patch.status).json({ error: 'template patch failed', detail: result });

    return res.status(200).json({
      ok: true,
      templateId: id,
      worker: 'v16-provider-retry-pinned',
      pipelineCommit: '5abd971895287e8e48c7990390dba48187c93e34',
    });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
}
