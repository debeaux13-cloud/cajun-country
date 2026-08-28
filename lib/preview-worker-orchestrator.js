import crypto from 'node:crypto';
import { BlobNotFoundError, head, put } from '@vercel/blob';
import { previewCallbackBase, previewWorkerEnvironment } from './preview-worker-origin';

const recordPath = id => `mcs/worker-orchestration/${id}.json`;
const idempotencyHash = value => crypto.createHash('sha256').update(value).digest('hex');
export { previewCallbackBase };
export const workerConfigurationPresent = () => Boolean(process.env.MCS_WORKER_SECRET && (process.env.Run_Pod_Key || process.env.RUNPOD_API_KEY) && process.env.BLOB_READ_WRITE_TOKEN && process.env.VERCEL_URL);
const runpodConfiguration = () => {
  const key = String(process.env.Run_Pod_Key || process.env.RUNPOD_API_KEY || '');
  const endpointId = String(process.env.MCS_RUNPOD_ENDPOINT_ID || 'id81aby9nfth9h');
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || '');
  const workerSecret = String(process.env.MCS_WORKER_SECRET || '');
  if (!key || !token || !workerSecret || !workerConfigurationPresent()) throw new Error('Preview worker configuration incomplete');
  return { key, token, workerSecret, base: `https://api.runpod.ai/v2/${endpointId}` };
};
export const structuredLog = (event, fields = {}) => console.info(JSON.stringify({ component: 'mcs-preview-worker', event, ...fields }));
async function readRecord(id, token) {
  try {
    const metadata = await head(recordPath(id), { token });
    const response = await fetch(metadata.downloadUrl || metadata.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Worker state read failed (${response.status})`);
    return response.json();
  } catch (error) {
    if (error instanceof BlobNotFoundError || /not found/i.test(String(error?.message))) return null;
    throw error;
  }
}
async function writeRecord(record, token) {
  await put(recordPath(record.id), JSON.stringify(record), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token });
}
async function dispatch(base, key, input) {
  let response;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await fetch(`${base}/run`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input }), signal: AbortSignal.timeout(15_000) });
      if (response.status < 500 || attempt === 2) break;
      structuredLog('dispatch_retry', { jobId: input.jobId, attempt });
    } catch (error) {
      if (attempt === 2) throw error;
      structuredLog('dispatch_retry', { jobId: input.jobId, attempt, message: String(error?.message || error) });
    }
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) throw new Error(payload?.error || payload?.message || `RunPod dispatch failed (${response.status})`);
  return { runpodJobId: String(payload.id), runpodStatus: String(payload.status || 'IN_QUEUE') };
}
export async function submitPreviewJob({ id, idempotencyKey }) {
  if (!/^[0-9a-f-]{20,}$/i.test(String(id)) || !idempotencyKey) throw new Error('Preview job ID and idempotency key are required');
  const { key, token, workerSecret, base } = runpodConfiguration();
  const existing = await readRecord(id, token);
  const fingerprint = idempotencyHash(idempotencyKey);
  if (existing?.idempotencyHash === fingerprint) return { ...existing, duplicate: true };
  if (existing) throw new Error('Preview job is already reserved');
  const pending = { id, idempotencyHash: fingerprint, state: 'dispatching', attempts: 0, callbackBase: previewCallbackBase(), createdAt: new Date().toISOString() };
  await writeRecord(pending, token);
  const result = await dispatch(base, key, { jobId: id, callbackBase: pending.callbackBase, mode: 'preview', workerSecret, duration_seconds: 60, preview_scene_count: 6, total_scene_count: 18, full_duration_seconds: 180 });
  const saved = { ...pending, ...result, state: 'submitted', attempts: 1, updatedAt: new Date().toISOString() };
  await writeRecord(saved, token);
  structuredLog('dispatched', { jobId: id, runpodJobId: saved.runpodJobId });
  return saved;
}
export async function getPreviewJob(id) {
  const { key, token, base } = runpodConfiguration();
  const record = await readRecord(id, token);
  if (!record) return null;
  if (!record.runpodJobId) return record;
  const response = await fetch(`${base}/status/${encodeURIComponent(record.runpodJobId)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`RunPod status failed (${response.status})`);
  const saved = { ...record, runpodStatus: String(payload.status || record.runpodStatus), statusCheckedAt: new Date().toISOString() };
  await writeRecord(saved, token);
  structuredLog('status_checked', { jobId: id, runpodStatus: saved.runpodStatus });
  return saved;
}
export async function recordPreviewCallback(id, callback) {
  const { token } = runpodConfiguration();
  const record = await readRecord(id, token);
  if (!record) return null;
  const saved = { ...record, callback: callback || {}, callbackAt: new Date().toISOString() };
  await writeRecord(saved, token);
  structuredLog('callback_recorded', { jobId: id });
  return saved;
}
