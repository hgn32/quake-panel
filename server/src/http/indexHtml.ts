import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

/**
 * `index.html` の配信。前置きパス付きで公開されている場合に `<base>` を差し込む。
 *
 * Home Assistant の Ingress はアドオンを `/api/hassio_ingress/<token>/` の下で
 * 公開し、アドオンへ中継するときに前置きを剥がす。つまりサーバーから見た
 * パスは素で動かしたときと同じで、ずれるのはブラウザ側の相対解決だけになる。
 * Supervisor は前置きを `X-Ingress-Path` ヘッダで教えてくれるので、それを
 * `<base href>` にして返せばクライアントは何も知らずに済む
 * (client/src/core/urls.ts が `document.baseURI` 基準で解決する)。
 */

/** 前置きパスとして受け入れる形。素性の知れない値を HTML へ入れないための門番。 */
const SAFE_INGRESS_PATH = /^\/[A-Za-z0-9._~\-/]*$/;

/**
 * `X-Ingress-Path` を取り出す。
 *
 * 直接ポートを開けている場合はこのヘッダを誰でも付けられるので、
 * 素直に信用せず「/ で始まる安全な文字だけのパス」に限る。`//` 始まりは
 * プロトコル相対 URL になり別ホストを基準にできてしまうため弾く。
 */
export function ingressBaseHref(req: IncomingMessage): string | null {
  const raw = req.headers['x-ingress-path'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const path = value.trim();
  if (path === '' || path === '/') return null;
  if (path.startsWith('//')) return null;
  if (!SAFE_INGRESS_PATH.test(path)) return null;
  // 末尾のスラッシュは必須。無いと `ws` が一階層上に解決されてしまう。
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * `<head>` の直後に `<base>` を入れる。
 * `<base>` は「最初の 1 つ」だけが効くため、先頭側に入れる必要がある。
 */
export function injectBaseHref(html: string, baseHref: string): string {
  const tag = `<base href="${baseHref}">`;
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (!headOpen) return `${tag}${html}`;
  const at = headOpen.index + headOpen[0].length;
  return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`;
}

/**
 * `index.html` を返す。差し込みがあるので長さが変わる。`content-length` を
 * 静的配信側の値のまま使わないよう、ここで完結させている。
 */
export function serveIndexHtml(
  rootDir: string,
  baseHref: string | null,
  res: ServerResponse,
): Promise<boolean> {
  const filePath = join(resolve(rootDir), 'index.html');
  return stat(filePath)
    .catch(() => null)
    .then((info) => {
      if (!info || !info.isFile()) return false;
      return readFile(filePath, 'utf8').then((source) => {
        const html = baseHref ? injectBaseHref(source, baseHref) : source;
        const body = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          // 前置きパスは接続元によって変わりうるので、共有キャッシュには載せない
          'cache-control': 'no-cache',
          'last-modified': info.mtime.toUTCString(),
        });
        res.end(body);
        return true;
      });
    });
}
