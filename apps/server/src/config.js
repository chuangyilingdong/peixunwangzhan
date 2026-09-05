export const DEPLOYMENT_MODE = ['development', 'internal-test', 'public'].includes(process.env.DEPLOYMENT_MODE) ? process.env.DEPLOYMENT_MODE : 'development';
export const PORT = Number(process.env.PORT || 8787);
export const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'http://localhost:5176';
export const ADMIN_APP_ORIGIN = process.env.ADMIN_APP_ORIGIN || 'http://localhost:5173';
export const STUDENT_APP_ORIGIN = process.env.STUDENT_APP_ORIGIN || 'http://localhost:5174';
export const ORG_APP_ORIGIN = process.env.ORG_APP_ORIGIN || 'http://localhost:5175';

export const AI_PROVIDER = String(process.env.AI_PROVIDER || 'local-mock').trim();
export const AI_PROVIDER_MODEL = String(process.env.AI_PROVIDER_MODEL || 'canvas-mock-v1').trim();
export const AI_PROVIDER_ENDPOINT = String(process.env.AI_PROVIDER_ENDPOINT || '').trim();
// Read only on the server; never accept this value from request payloads.
export const AI_PROVIDER_API_KEY = String(process.env.AI_PROVIDER_API_KEY || '').trim();
export const AI_PROVIDER_TIMEOUT_MS = Math.max(1000, Math.min(300000, Number(process.env.AI_PROVIDER_TIMEOUT_MS || 120000)));
export const AI_PROVIDER_POLL_INTERVAL_MS = Math.max(250, Math.min(10000, Number(process.env.AI_PROVIDER_POLL_INTERVAL_MS || 2000)));
export const AI_PROVIDER_VOICE = String(process.env.AI_PROVIDER_VOICE || 'alloy').trim() || 'alloy';

function parseEndpointMap(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze({});
    return Object.freeze(Object.fromEntries(Object.entries(parsed).map(([key, endpoint]) => [String(key).trim().toUpperCase(), String(endpoint || '').trim()]).filter(([, endpoint]) => endpoint)));
  } catch {
    return Object.freeze({});
  }
}

// Optional per-modality endpoints for providers whose image/audio/video APIs are not all mounted below one base URL.
export const AI_PROVIDER_MODALITY_ENDPOINTS = parseEndpointMap(process.env.AI_PROVIDER_MODALITY_ENDPOINTS);

export const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || [PUBLIC_SITE_URL, ADMIN_APP_ORIGIN, STUDENT_APP_ORIGIN, ORG_APP_ORIGIN].filter(Boolean).join(',')).split(',').map((value) => value.trim()).filter(Boolean);
