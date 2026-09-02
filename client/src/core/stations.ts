import { projectToPixel } from '@quake-panel/shared';
import { resolveUrl } from './urls.js';

export interface KmoniStation {
  net: string;
  code: string;
  name: string;
  pref: string;
  lat: number;
  lon: number;
  /** 配信画像のピクセル座標 (読み込み時に projectToPixel で求めておく) */
  x: number;
  y: number;
}

/** JSON 由来の 1 観測点の生データ (列の並びは columns で決まる) */
type StationRow = ReadonlyArray<string | number>;

interface StationListData {
  attribution: string;
  columns: string[];
  stations: StationRow[];
}

/**
 * 防災科研の公式観測点リスト (K-NET + KiK-net)。
 *
 * `Basemap` と同じく UI 非依存。読み込みに失敗しても表示は続けられるよう
 * reject させず、`isLoaded()` で状態を確認できるようにしてある。
 */
export class StationList {
  private stations: KmoniStation[] = [];
  private loaded = false;
  private dataAttribution = '';

  load(url = resolveUrl('/assets/kmoni-stations.json')): Promise<void> {
    return fetch(url)
      .then((res) => {
        if (!res.ok) {
          return Promise.reject(new Error(`観測点リストを読み込めませんでした: HTTP ${res.status}`));
        }
        return res.json() as Promise<StationListData>;
      })
      .then((data) => {
        const index = columnIndex(data.columns);
        this.stations = data.stations.map((row) => rowToStation(row, index));
        this.dataAttribution = data.attribution;
        this.loaded = true;
      });
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** 表示に使う観測点の一覧 */
  all(): readonly KmoniStation[] {
    return this.stations;
  }

  /**
   * 配信画像のピクセル座標にいちばん近い観測点。
   * `maxPx` を超えたら null (クリックが観測点から離れすぎている)。
   *
   * 1,749 点の総当たりだが、呼ばれるのはクリック時だけなので毎秒の負荷にはならない。
   */
  nearest(x: number, y: number, maxPx: number): KmoniStation | null {
    return this.stations.reduce<{ station: KmoniStation; distance: number } | null>(
      (best, station) => {
        const distance = Math.hypot(station.x - x, station.y - y);
        if (distance > maxPx) return best;
        if (best === null || distance < best.distance) return { station, distance };
        return best;
      },
      null,
    )?.station ?? null;
  }

  get attribution(): string {
    return this.dataAttribution;
  }
}

/** `columns` の並びから各項目の位置を引けるようにする (フォーマット変更への耐性) */
function columnIndex(columns: string[]): Record<'net' | 'code' | 'name' | 'pref' | 'lat' | 'lon', number> {
  return {
    net: columns.indexOf('net'),
    code: columns.indexOf('code'),
    name: columns.indexOf('name'),
    pref: columns.indexOf('pref'),
    lat: columns.indexOf('lat'),
    lon: columns.indexOf('lon'),
  };
}

function rowToStation(
  row: StationRow,
  index: Record<'net' | 'code' | 'name' | 'pref' | 'lat' | 'lon', number>,
): KmoniStation {
  const net = String(row[index.net] ?? '');
  const code = String(row[index.code] ?? '');
  const name = String(row[index.name] ?? '');
  const pref = String(row[index.pref] ?? '');
  const lat = Number(row[index.lat] ?? 0);
  const lon = Number(row[index.lon] ?? 0);
  const p = projectToPixel(lat, lon);
  return { net, code, name, pref, lat, lon, x: p.x, y: p.y };
}
