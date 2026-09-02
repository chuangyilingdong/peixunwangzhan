import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({root,plugins:[react()],server:{port:5176,strictPort:true},preview:{port:6176,strictPort:true},build:{outDir:'dist',emptyOutDir:true}});
