export const PORT = Number(process.env.PORT || 8787);
export const ADMIN_APP_ORIGIN = process.env.ADMIN_APP_ORIGIN || 'http://localhost:5173';
export const STUDENT_APP_ORIGIN = process.env.STUDENT_APP_ORIGIN || 'http://localhost:5174';
export const ORG_APP_ORIGIN = process.env.ORG_APP_ORIGIN || 'http://localhost:5175';

export const AI_PROVIDER = String(process.env.AI_PROVIDER || 'local-mock').trim();
export const AI_PROVIDER_MODEL = String(process.env.AI_PROVIDER_MODEL || 'canvas-mock-v1').trim();
export const AI_PROVIDER_ENDPOINT = String(process.env.AI_PROVIDER_ENDPOINT || '').trim();
