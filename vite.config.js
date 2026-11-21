import { defineConfig } from 'vite';

// Relative base so the built site works under the GitHub Pages project path
// (/midad-kimi/) as well as in local preview. Routing uses the URL hash,
// so page refreshes never depend on server rewrites.
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true }
});
