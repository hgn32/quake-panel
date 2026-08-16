import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * `staticDir` (`.env` の `STATIC_DIR`。既定 `public`) はリポジトリルートからの
 * 相対パスとして扱う仕様だが、素の `resolve()` は `process.cwd()` を基準にするため
 * 起動時の cwd 次第で解決先がずれてしまう
 * (`npm run dev -w @quake-panel/server` はワークスペースディレクトリ `server/` を
 * cwd にして実行する一方、`npm start` はリポジトリルートを cwd にする)。
 *
 * cwd に左右されないよう、呼び出し元モジュール自身の位置 (`import.meta.url`) を
 * 起点にリポジトリルートを求めてから `staticDir` を解決する。呼び出し元
 * (`server.ts`) はビルド後 `dist/http/server.js` になるが、`src/http/*.ts` /
 * `dist/http/*.js` のどちらでも「ここから 2 階層上が `server/` パッケージルート、
 * さらに 1 階層上がリポジトリルート」という位置関係は変わらないので、
 * dev/prod のどちらの cwd でも同じ結果になる。
 */
export function resolveStaticRoot(moduleUrl: string, staticDir: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const repoRoot = resolve(moduleDir, '../../..');
  return resolve(repoRoot, staticDir);
}

/**
 * クライアントのビルド成果物を配る。
 * ハッシュ付きファイル名 (Vite の既定) は長期キャッシュ、それ以外は都度検証にする。
 */
export function serveStatic(
  rootDir: string,
  urlPath: string,
  res: ServerResponse,
): Promise<boolean> {
  const root = resolve(rootDir);
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(root, relative);
  // 上位ディレクトリへ抜ける経路は配らない
  if (filePath !== root && !filePath.startsWith(root + sep)) return Promise.resolve(false);

  return stat(filePath)
    .catch(() => null)
    .then((info) => {
      if (!info || !info.isFile()) return false;

      const ext = extname(filePath).toLowerCase();
      const hashed = /-[A-Za-z0-9_]{8,}\.(js|css|woff2)$/.test(filePath);
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        'last-modified': info.mtime.toUTCString(),
      });
      return new Promise<boolean>((resolvePromise, reject) => {
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        stream.on('end', () => resolvePromise(true));
        stream.pipe(res);
      });
    });
}
