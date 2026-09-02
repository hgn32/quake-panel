#!/usr/bin/env node
/**
 * 防災科研の公式観測点リスト (K-NET + KiK-net) を配信用 JSON に変換する。
 *
 * 強震モニタの観測点シンボルの緯度経度は、この公式リストの値と kmoni の
 * 描画位置が一致することを実測で確認済み (画像から分離した 1,366 点すべてが
 * 2.86px 以内、中央値 1.30px、2026-09-02)。したがって観測点の位置は画像を
 * 解析せずこのリストから得られる。配信画像そのものは加工しない
 * (取得・中継するだけで、ここで扱うのは別途公開されている観測点情報)。
 *
 * 入手元 (要ユーザー登録・要ダウンロード): 防災科学技術研究所
 *   https://www.kyoshin.bosai.go.jp/ja/stationlist/
 * サイトでユーザー登録のうえ「観測点情報」から CSV をダウンロードし、
 * --source にそのパスを渡して実行する。
 *
 *   node scripts/build-station-list.mjs --source <CSV のパス> [--out <出力先>]
 *
 * 入力 CSV は Shift_JIS・ヘッダー行なし・カンマ区切り 11 列
 * (観測網, 観測点コード, 名称(日本語), 名称(英字), 緯度, 経度, 標高,
 *  地震計設置深さ, 都道府県, 機種, (空)) という前提で読む。
 * リストが更新されたら再取得してこのスクリプトを再実行する。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULT_OUT = resolve(ROOT, 'client/public/assets/kmoni-stations.json');
/** 今回変換した CSV の入手日 (出力 JSON にそのまま残す) */
const LISTED_AT = '2026-09-02';

function parseArgs(argv) {
  const args = { source: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--source' && value) args.source = resolve(value);
    else if (key === '--out' && value) args.out = resolve(value);
  }
  return args;
}

/** CSV の 1 行を列配列にする (このリストにカンマを含む引用フィールドは無い) */
function parseLine(line) {
  return line.split(',');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) {
    throw new Error('--source <CSV のパス> を指定してください (防災科研の観測点情報 CSV)');
  }

  const buffer = await readFile(args.source);
  const text = new TextDecoder('shift_jis').decode(buffer);
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);

  const stations = lines.map((line) => {
    const cols = parseLine(line);
    const net = cols[0] ?? '';
    const code = cols[1] ?? '';
    const name = cols[2] ?? '';
    const pref = cols[8] ?? '';
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`緯度経度が数値ではありません: ${line}`);
    }
    return [net, code, name, pref, lat, lon];
  });

  const output = {
    attribution: '「強震観測網（K-NET, KiK-net）」(防災科学技術研究所) の観測点情報を加工して作成',
    source: 'https://www.kyoshin.bosai.go.jp/ja/stationlist/',
    listedAt: LISTED_AT,
    columns: ['net', 'code', 'name', 'pref', 'lat', 'lon'],
    stations,
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(output));

  const knetCount = stations.filter(([net]) => net === 'K-NET').length;
  const kiknetCount = stations.filter(([net]) => net === 'KiK-net').length;
  process.stdout.write(
    `観測点 ${stations.length} 点を書き出した (K-NET ${knetCount} 点 / KiK-net ${kiknetCount} 点)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
