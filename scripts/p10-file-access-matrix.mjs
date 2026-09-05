import { strict as assert } from 'node:assert';
import { unlink } from 'node:fs/promises';
const dbPath = `./.tmp-p10-access-${Date.now()}.db`;
process.env.PLATFORM_DB_PATH = dbPath;
const { q, nowIso } = await import('../apps/server/src/lib.js');
const { authorizeFileAccess } = await import('../apps/server/src/routes/fileAssets.js');
const now = nowIso();
q(`INSERT INTO organizations(id,name,contract_start_at,contract_expires_at,created_at,updated_at) VALUES ('org-a','机构 A',?,?,?,?),('org-b','机构 B',?,?,?,?)`, [now, now, now, now, now, now, now, now]);
q(`INSERT INTO file_assets(id,owner_type,owner_org_id,storage_kind,file_name,file_size,category,visibility,status,review_status,metadata,created_at,updated_at) VALUES
 ('public','PLATFORM',NULL,'EXTERNAL_URL','public.pdf',1,'GENERAL','PUBLIC_PLATFORM','ACTIVE','NOT_REQUIRED','{}',?,?),
 ('org-a','ORG','org-a','EXTERNAL_URL','org.pdf',1,'GENERAL','ORG','ACTIVE','NOT_REQUIRED','{}',?,?),
 ('assigned','ORG','org-a','EXTERNAL_URL','assigned.pdf',1,'GENERAL','ASSIGNED_ORGS','ACTIVE','NOT_REQUIRED','{}',?,?)`, [now,now,now,now,now,now]);
q(`INSERT INTO file_access_grants(id,file_id,grant_type,org_id,permission,created_at) VALUES ('grant-b','assigned','ORG','org-b','READ',?)`, [now]);
const ctx = (role, id, orgId) => ({ auth: { user: { role, id, orgId } } });
assert.equal(authorizeFileAccess(ctx('STUDENT','s-a','org-a'), 'public').id, 'public');
assert.equal(authorizeFileAccess(ctx('STUDENT','s-a','org-a'), 'org-a').id, 'org-a');
assert.equal(authorizeFileAccess(ctx('STUDENT','s-b','org-b'), 'assigned').id, 'assigned');
assert.throws(() => authorizeFileAccess(ctx('STUDENT','s-b','org-b'), 'org-a'), (e) => e.code === 'FILE_ACCESS_DENIED');
assert.throws(() => authorizeFileAccess(ctx('TEACHER','t-a','org-c'), 'assigned'), (e) => e.code === 'FILE_ACCESS_DENIED');
assert.equal(authorizeFileAccess(ctx('SUPER_ADMIN','root',null), 'org-a').id, 'org-a');
console.log('P10 file access matrix: 6 pass / 0 fail');


