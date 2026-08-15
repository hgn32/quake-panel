type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level] ?? ORDER.info;
}

/**
 * 1 行書き出す。
 *
 * Home Assistant のログタブは標準出力/標準エラーをそのまま出すので、
 * ここが唯一の出力口になる (console は使わない)。
 */
function emit(level: Level, scope: string, message: string, extra?: string): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(extra === undefined ? `${line}\n` : `${line} ${extra}\n`);
}

export interface Logger {
  debug(message: string, extra?: string): void;
  info(message: string, extra?: string): void;
  warn(message: string, extra?: string): void;
  error(message: string, extra?: string): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

/**
 * 例外を短い説明にする。
 *
 * 引数は Error 型で受けるが、実際には Error 以外が投げられることもあるので
 * 中で確かめる (catch した値は `as Error` で渡ってくる)。
 */
export function describeError(error: Error): string {
  if (error instanceof Error) {
    return error.cause ? `${error.message} (cause: ${String(error.cause)})` : error.message;
  }
  return String(error);
}
