import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` proxies /api and /config.json to a deployed site: SITE=https://xxxx.cloudfront.net
const site = process.env.SITE;

export default defineConfig({
  plugins: [react()],
  server: site
    ? { proxy: { '/api': { target: site, changeOrigin: true }, '/config.json': { target: site, changeOrigin: true } } }
    : undefined,
});
