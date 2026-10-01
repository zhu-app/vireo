import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:8080';
const proxy = {
  '/api': { target: API_ORIGIN, changeOrigin: true },
  '/uploads': { target: API_ORIGIN, changeOrigin: true },
};

// 前后端分离：开发/预览态由 Vite 代理转发 /api 与 /uploads；生产态由 Nginx 完成同源转发。
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { outDir: 'dist', sourcemap: false },
});
