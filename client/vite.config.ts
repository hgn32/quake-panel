import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/**
 * ビルド時のコミットハッシュ。設定画面に「アプリバージョン」として出すためだけに使う。
 * Docker ビルドでは .git を含めていないので `git rev-parse` が使えず、
 * その場合は release/Dockerfile が build-arg 経由で渡す環境変数 COMMIT_HASH を使う。
 * どちらも取れなければ空文字列にしておき、表示側で「開発版」とする。
 */
function resolveCommitHash(): string {
  if (process.env.COMMIT_HASH) return process.env.COMMIT_HASH;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/**
 * ビルドした日時 (JST)。コミットハッシュと並べて設定画面に出す。
 *
 * ハッシュだけだと「そのコミットで確かにビルドし直したのか」が分からず、
 * 古い成果物が動いていても気づけない (実際に古いビルドのまま「直っていない」と
 * 判断しかけた)。日時が並んでいれば、その場で作り直したかどうかが分かる。
 *
 * 実行環境の TZ に依らず JST で出す。ICU の有無に左右されないよう、
 * +9 時間して ISO 文字列を切り出す方法で組み立てる。
 * Docker ビルドで固定したい場合は環境変数 BUILD_DATE で差し替えられる。
 */
function resolveBuildDate(): string {
  if (process.env.BUILD_DATE) return process.env.BUILD_DATE;
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 16).replace('T', ' ');
}

const commitHash = resolveCommitHash();
const buildDate = resolveBuildDate();

/**
 * キオスク端末で 1 回読むだけなので、コード分割よりも
 * 「1 ファイルにまとまっていて確実に読める」ことを優先する。
 */
export default defineConfig({
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  // 配信されるパスが `/` 直下とは限らないため、成果物内の参照は相対パスにする。
  // どこに置かれても index.html からの相対で読めるようにする。
  base: './',
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
