/**
 * サーバーのエンドポイントを「今どこに置かれているか」に合わせて解決する。
 *
 * 素で動かすときはルート (`/`) 直下だが、Home Assistant の Ingress 経由では
 * `/api/hassio_ingress/<token>/` のような前置きが付いた URL で配信される。
 * Supervisor は前置きを剥がしてからアドオンへ中継するので、サーバー側の
 * パス (`/ws` など) は変わらない。ずれるのはブラウザ側だけなので、
 * ここで `document.baseURI` 基準に解決してしまえば両方で同じコードが動く。
 *
 * `document.baseURI` は index.html に `<base href>` があればその値、
 * 無ければ現在の URL になる。サーバーは Ingress 経由のときだけ `<base>` を
 * 差し込む (server/src/http/indexHtml.ts)。
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
 * 相対解決の基準。末尾がスラッシュで終わっていないディレクトリ URL だと
 * 一階層上に解決されてしまうため、`<base>` を注入する側で必ずスラッシュを
 * 付けている (`/index.html` で終わる場合は同じ階層に解決されるので問題ない)。
 */
function baseUrl(): string {
  return document.baseURI;
}
