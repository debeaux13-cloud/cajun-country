import { recordPreviewCallback, structuredLog } from '../../../../../../lib/preview-worker-orchestrator';
function authorized(req) { const secret = process.env.MCS_WORKER_SECRET || ''; const header = req.headers.authorization || ''; return Boolean(secret) && (header === secret || header === `Bearer ${secret}`); }
export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try { const record = await recordPreviewCallback(String(req.query.id || ''), req.body); if (!record) return res.status(404).json({ error: 'Job not found' }); return res.status(200).json({ ok: true }); }
  catch (error) { structuredLog('callback_failed', { jobId: String(req.query.id || ''), message: String(error?.message || error) }); return res.status(502).json({ error: 'Worker callback failed' }); }
}
