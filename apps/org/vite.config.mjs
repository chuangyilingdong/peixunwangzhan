import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const canvas = fileURLToPath(new URL('../../packages/canvas/src', import.meta.url));
const appBase = process.env.VITE_APP_BASE || '/org/';
export default defineConfig({ root, base: appBase, plugins: [react()], resolve: { alias: [{ find: '@platform/shared', replacement: shared }, { find: '@platform/canvas', replacement: canvas }] }, server: { port: 5175, strictPort: true, proxy: { '/api': 'http://localhost:8787' } }, preview: { port: 6175, strictPort: true, proxy: { '/api': 'http://localhost:8787' } }, build: { outDir: 'dist', emptyOutDir: true } });
