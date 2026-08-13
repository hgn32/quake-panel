import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

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
 * クライアントのビルド成果物を配る。
 * ハッシュ付きファイル名 (Vite の既定) は長期キャッシュ、それ以外は都度検証にする。
 */
export async function serveStatic(
  rootDir: string,
  urlPath: string,
  res: ServerResponse,
): Promise<boolean> {
  const root = resolve(rootDir);
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(root, relative);
  if (filePath !== root && !filePath.startsWith(root + sep)) return false;

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const ext = extname(filePath).toLowerCase();
  const hashed = /-[A-Za-z0-9_]{8,}\.(js|css|woff2)$/.test(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'last-modified': info.mtime.toUTCString(),
  });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
    stream.pipe(res);
  });
  return true;
}
