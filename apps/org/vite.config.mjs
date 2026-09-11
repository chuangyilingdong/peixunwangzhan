import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const canvas = fileURLToPath(new URL('../../packages/canvas/src', import.meta.url));
const appBase = process.env.VITE_APP_BASE || '/org/';
// 与 website 一致：本地验证时可以指向临时后端（VITE_DEV_API_TARGET），默认仍是 8787
const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:8787';
export default defineConfig({ root, base: appBase, plugins: [react()], resolve: { alias: [{ find: '@platform/shared', replacement: shared }, { find: '@platform/canvas', replacement: canvas }] }, server: { port: 5175, strictPort: true, proxy: { '/api': apiTarget } }, preview: { port: 6175, strictPort: true, proxy: { '/api': apiTarget } }, build: { outDir: 'dist', emptyOutDir: true } });
