/**
 * vite.config.ts の `define` で文字列リテラルへ置き換えられるビルド時定数。
 * ここでは型だけを宣言する (値はビルド時に埋め込まれるので実体は無い)。
 */
declare const __COMMIT_HASH__: string;
