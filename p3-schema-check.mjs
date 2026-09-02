import { rows } from './packages/database/src/schema.js';
const required = ['work_annotations', 'generation_jobs', 'media_assets'];
const found = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map((item) => item.name));
for (const table of required) if (!found.has(table)) throw new Error(`missing ${table}`);
console.log(`PASS P3 schema tables: ${required.join(', ')}`);
