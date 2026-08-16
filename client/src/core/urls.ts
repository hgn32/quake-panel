/**
 * サーバーのエンドポイントを「今どこに置かれているか」に合わせて解決する。
 *
 * 配信された URL (document.baseURI) を基準に相対で解決するので、
 * ルート直下に置いても、前置きパスを剥がすリバースプロキシの配下に
 * 置いても、同じコードで動く。
 */

/** `ENDPOINTS` の絶対パスを、配信されている場所からの相対 URL に直す */
export function resolveUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), baseUrl()).toString();
}

/** WebSocket 用。http(s) → ws(s) の対応もここで済ませる */
export function resolveWsUrl(path: string): string {
  const url = new URL(path.replace(/^\/+/, ''), baseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * 相対解決の基準。`document.baseURI` は `<base href>` があればその値、
 * 無ければ現在の URL になる。ディレクトリ URL は末尾スラッシュで
 * 終わっている前提 (`/index.html` で終わる場合は同じ階層に解決される)。
 */
function baseUrl(): string {
  return document.baseURI;
}
