/**
 * vite.config.ts の `define` で文字列リテラルへ置き換えられるビルド時定数。
 * ここでは型だけを宣言する (値はビルド時に埋め込まれるので実体は無い)。
 */
declare const __COMMIT_HASH__: string;
/** ビルドした日時 (JST、`YYYY-MM-DD HH:mm`)。取れなければ空文字列。 */
declare const __BUILD_DATE__: string;
