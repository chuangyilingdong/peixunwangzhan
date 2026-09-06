import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
const file = process.env.AI_PROVIDER_SECRET_FILE || '/etc/ai-kids-platform/provider-secrets.json';
const key = createHash('sha256').update(String(process.env.AUTH_PEPPER || 'p0-local-pepper')).digest();
function readStore() { try { const x=JSON.parse(readFileSync(file,'utf8')); return x.secrets && typeof x.secrets === 'object' ? x.secrets : (x.data ? { default: x } : {}); } catch { return {}; } }
function encrypt(text) { const iv=randomBytes(12); const c=createCipheriv('aes-256-gcm',key,iv); const data=Buffer.concat([c.update(text,'utf8'),c.final()]); return {iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data:data.toString('base64')}; }
function decrypt(x) { try { if(!x?.iv||!x?.tag||!x?.data)return ''; const d=createDecipheriv('aes-256-gcm',key,Buffer.from(x.iv,'hex')); d.setAuthTag(Buffer.from(x.tag,'hex')); return Buffer.concat([d.update(Buffer.from(x.data,'base64')),d.final()]).toString('utf8'); } catch { return ''; } }
export function getProviderApiKey(channelId = 'default') { return decrypt(readStore()[String(channelId || 'default')]); }
export function setProviderApiKey(value, channelId = 'default') { const text=String(value||'').trim(); if(!text) return; const secrets=readStore(); secrets[String(channelId || 'default')]=encrypt(text); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,JSON.stringify({version:1,secrets}),{mode:0o600}); }
export function hasProviderApiKey(channelId = 'default') { return Boolean(getProviderApiKey(channelId)); }
