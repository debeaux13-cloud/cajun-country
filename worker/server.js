import crypto from 'node:crypto';
import express from 'express';
import { BlobNotFoundError, head, put } from '@vercel/blob';

const app = express();
app.use(express.json({ limit: '1mb' }));

const callbackBase = () => String(process.env.MCS_CALLBACK_BASE || '').replace(/\/$/, '');
const runpodBase = () => {
  const id = String(process.env.MCS_RUNPOD_ENDPOINT_ID || 'id81aby9nfth9h').trim();
  return `https://api.runpod.ai/v2/${id}`;
};
const secret = () => String(process.env.MCS_WORKER_SECRET || '');
const runpodKey = () => String(process.env.Run_Pod_Key || process.env.RUNPOD_API_KEY || '');
const blobToken = () => String(process.env.BLOB_READ_WRITE_TOKEN || '');
const jobPath = id => `mcs/orchestration/${id}.json`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function log(event, fields = {}) { console.info(JSON.stringify({ component: 'mcs-worker-orchestrator', event, ...fields })); }
function authorized(req) {
  const value = secret();
  const header = String(req.header('authorization') || '');
  return value && (header === value || header === `Bearer ${value}`);
}
function requireAuth(req, res, next) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function requireConfiguration() {
  if (!secret() || !runpodKey() || !blobToken() || !callbackBase()) throw new Error('Preview worker configuration incomplete');
}
async function readJob(id) {
  try {
    const metadata = await head(jobPath(id), { token: blobToken() });
    const response = await fetch(metadata.downloadUrl || metadata.url, { headers: { Authorization: `Bearer ${blobToken()}` } });
    if (!response.ok) throw new Error(`Blob read failed (${response.status})`);
    return response.json();
  } catch (error) {
    if (error instanceof BlobNotFoundError || /not found/i.test(String(error?.message))) return null;
    throw error;
  }
}
async function writeJob(job) {
  await put(jobPath(job.id), JSON.stringify(job), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: blobToken() });
}
async function timedFetch(url, options, timeoutMs = 15_000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}
async function dispatch(job) {
  const options = {
    method: 'POST', headers: { Authorization: `Bearer ${runpodKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { jobId: job.id, callbackBase: callbackBase(), mode: job.mode, duration_seconds: job.mode === 'preview' ? 60 : 180, preview_scene_count: 6, total_scene_count: 18, full_duration_seconds: 180 } })
  };
  let response;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await timedFetch(`${runpodBase()}/run`, options);
      if (response.status < 500 || attempt === 2) break;
      log('dispatch_retry', { id: job.id, attempt });
    } catch (error) {
      if (attempt === 2) throw error;
      log('dispatch_retry', { id: job.id, attempt, message: String(error?.message || error) });
    }
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) throw new Error(payload?.error || payload?.message || `RunPod dispatch failed (${response.status})`);
  return { id: String(payload.id), status: String(payload.status || 'IN_QUEUE') };
}

app.get('/health', (_req, res) => {
  const configured = Boolean(secret() && runpodKey() && blobToken() && callbackBase());
  log('health', { configured });
  res.status(configured ? 200 : 503).json({ ok: configured, service: 'mcs-worker-orchestrator', generationInvoked: false });
});

app.post('/jobs', requireAuth, async (req, res) => {
  const id = String(req.body?.jobId || '');
  const mode = String(req.body?.mode || '');
  const idempotencyKey = String(req.header('idempotency-key') || '');
  if (!/^[0-9a-f-]{20,}$/i.test(id) || !idempotencyKey || mode !== 'preview') return res.status(400).json({ error: 'Preview jobId and Idempotency-Key are required' });
  try {
    requireConfiguration();
    const existing = await readJob(id);
    if (existing && existing.idempotencyHash === hash(idempotencyKey)) return res.status(200).json({ ...existing, duplicate: true });
    if (existing) return res.status(409).json({ error: 'Job ID already reserved' });
    const job = { id, mode, idempotencyHash: hash(idempotencyKey), state: 'dispatching', attempts: 0, createdAt: new Date().toISOString() };
    await writeJob(job);
    const runpod = await dispatch(job);
    const saved = { ...job, state: 'submitted', runpodJobId: runpod.id, runpodStatus: runpod.status, attempts: 1, updatedAt: new Date().toISOString() };
    await writeJob(saved); log('dispatched', { id, mode, runpodJobId: runpod.id });
    res.status(202).json(saved);
  } catch (error) { log('dispatch_failed', { id, message: String(error?.message || error) }); res.status(502).json({ error: 'Worker dispatch failed' }); }
});

app.get('/jobs/:id', requireAuth, async (req, res) => {
  try {
    requireConfiguration();
    const job = await readJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.runpodJobId) return res.status(200).json(job);
    const response = await timedFetch(`${runpodBase()}/status/${encodeURIComponent(job.runpodJobId)}`, { headers: { Authorization: `Bearer ${runpodKey()}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`RunPod status failed (${response.status})`);
    const saved = { ...job, runpodStatus: String(payload.status || job.runpodStatus), statusCheckedAt: new Date().toISOString() };
    await writeJob(saved); log('status', { id: job.id, runpodStatus: saved.runpodStatus });
    res.json(saved);
  } catch (error) { log('status_failed', { id: req.params.id, message: String(error?.message || error) }); res.status(502).json({ error: 'Worker status failed' }); }
});

app.post('/callbacks/runpod', requireAuth, async (req, res) => {
  const id = String(req.body?.jobId || '');
  if (!id) return res.status(400).json({ error: 'jobId required' });
  try {
    requireConfiguration();
    const job = await readJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const saved = { ...job, state: String(req.body?.state || job.state), callbackAt: new Date().toISOString(), callback: req.body };
    await writeJob(saved); log('callback_received', { id, state: saved.state });
    res.json({ ok: true });
  } catch (error) { log('callback_failed', { id, message: String(error?.message || error) }); res.status(502).json({ error: 'Worker callback failed' }); }
});

export default app;
