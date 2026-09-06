import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
const file = process.env.AI_PROVIDER_SECRET_FILE || '/etc/ai-kids-platform/provider-secrets.json';
const key = createHash('sha256').update(String(process.env.AUTH_PEPPER || 'p0-local-pepper')).digest();
export function getProviderApiKey() { try { const x=JSON.parse(readFileSync(file,'utf8')); if(!x.iv||!x.tag||!x.data)return ''; const d=createDecipheriv('aes-256-gcm',key,Buffer.from(x.iv,'hex')); d.setAuthTag(Buffer.from(x.tag,'hex')); return Buffer.concat([d.update(Buffer.from(x.data,'base64')),d.final()]).toString('utf8'); } catch { return ''; } }
export function setProviderApiKey(value) { const text=String(value||'').trim(); if(!text) return; const iv=randomBytes(12); const c=createCipheriv('aes-256-gcm',key,iv); const data=Buffer.concat([c.update(text,'utf8'),c.final()]); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,JSON.stringify({iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data:data.toString('base64')}),{mode:0o600}); }
export function hasProviderApiKey() { return Boolean(getProviderApiKey()); }
