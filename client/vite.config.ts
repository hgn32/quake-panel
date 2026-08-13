import { defineConfig } from 'vite';

/**
 * キオスク端末で 1 回読むだけなので、コード分割よりも
 * 「1 ファイルにまとまっていて確実に読める」ことを優先する。
 */
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 開発時はローカルのサーバー (npm run dev) へ中継する
      '/api': 'http://localhost:8080',
      '/kmoni': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
