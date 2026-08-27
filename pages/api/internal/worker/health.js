import { structuredLog, workerConfigurationPresent } from '../../../../lib/preview-worker-orchestrator';
export default function handler(_req, res) {
  const configured = workerConfigurationPresent();
  structuredLog('health', { configured });
  res.status(configured ? 200 : 503).json({ ok: configured, service: 'mcs-preview-worker', generationInvoked: false });
}
