import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
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
  // `decodeURIComponent` は不正な %-エンコード (例: `/%zz`) を渡されると同期的に
  // `URIError` を投げる。ここで捕まえず素通しすると、呼び出し元の
  // `handle().catch(...)` という Promise チェーンに乗る前に例外が同期伝播し、
  // uncaughtException でプロセスごと落ちる (実機で確認済み)。
  // ここで捕まえて 400 を返せば、以後のリクエストにも普通に応答し続けられる。
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
    return Promise.resolve(true);
  }
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
      // `stream.pipe(res)` だけだと、クライアントが転送途中で切断したときに
      // read stream が破棄されず fd が漏れ続け、Promise も settle しないまま
      // 残ってしまう。`pipeline` なら片方が終了・破棄されたときにもう片方も
      // 必ず破棄され、結果 (成功でもエラーでも) を必ずコールバックへ渡してくれる。
      return new Promise<boolean>((resolvePromise, reject) => {
        const stream = createReadStream(filePath);
        pipeline(stream, res, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise(true);
        });
      });
    });
}
