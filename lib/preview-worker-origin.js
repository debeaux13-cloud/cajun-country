export const previewCallbackBase=()=> 'https://main-character-studios.vercel.app';
export const previewWorkerEnvironment=(environment=process.env.VERCEL_ENV)=>environment==='preview';
