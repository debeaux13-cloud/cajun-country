const test = require('node:test');
const assert = require('node:assert/strict');
async function load() { return import(`../lib/preview-worker-origin.js?test=${Date.now()}`); }
test('derives callback origin from the current Vercel deployment URL', async () => { const { previewCallbackBase } = await load(); assert.equal(previewCallbackBase('mcs-git-feature-example.vercel.app'), 'https://mcs-git-feature-example.vercel.app'); });
test('rejects a missing or non-Vercel callback origin', async () => { const { previewCallbackBase } = await load(); assert.throws(() => previewCallbackBase('')); assert.throws(() => previewCallbackBase('example.com')); });
test('health configuration requires only canonical Preview dependencies', async () => { const before = { ...process.env }; process.env.MCS_WORKER_SECRET = 'x'; process.env.Run_Pod_Key = 'x'; process.env.BLOB_READ_WRITE_TOKEN = 'x'; process.env.VERCEL_URL = 'mcs-git-feature.vercel.app'; process.env.VERCEL_ENV = 'preview'; const { previewWorkerEnvironment } = await load(); assert.equal(previewWorkerEnvironment(), true); Object.assign(process.env, before); });
