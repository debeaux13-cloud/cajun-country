export const previewCallbackBase = (hostname = process.env.VERCEL_URL) => {
  const value = String(hostname || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/i.test(value)) throw new Error('Preview deployment URL is unavailable');
  return `https://${value}`;
};
export const previewWorkerEnvironment = (environment = process.env.VERCEL_ENV) => environment === 'preview';
