import {
  parseJstDateTime,
  toIso,
  type EewRegion,
  type EewState,
  type IntensityLevel,
  type QuakeInfo,
  type TsunamiArea,
  type TsunamiGrade,
  type TsunamiInfo,
  type EewDetection,
} from '@quake-panel/shared';
import type { P2PEew, P2PEewDetection, P2PQuake, P2PTsunami } from './p2pTypes.js';

const VALID_SCALES = new Set([10, 20, 30, 40, 45, 46, 50, 55, 60, 70]);

/** P2P の scale 整数を内部表現へ。-1 (不明) や未知の値は null。 */
export function toIntensity(scale: number | undefined | null): IntensityLevel | null {
  if (scale == null) return null;
  return VALID_SCALES.has(scale) ? (scale as IntensityLevel) : null;
}

/**
 * P2P は不明値を -1 で表す (震度速報のように震源が未確定な電文で出てくる)。
 * 深さ 0 は「ごく浅い」で有効なので、0 と -1 を取り違えないこと。
 */
const nz = (value: number | undefined): number | null =>
  value == null || !Number.isFinite(value) || value === -1 ? null : value;

export function parseQuake(msg: P2PQuake, receivedAt: Date): QuakeInfo {
  const eq = msg.earthquake ?? {};
  const hypo = eq.hypocenter ?? {};
  return {
    id: msg.id ?? `${msg.code}-${msg.time ?? receivedAt.toISOString()}`,
    issuedAt: toIso(parseJstDateTime(msg.issue?.time ?? msg.time)),
    occurredAt: toIso(parseJstDateTime(eq.time)),
    issueType: msg.issue?.type ?? 'Unknown',
    hypocenter: {
      name: hypo.name?.trim() || '不明',
      lat: nz(hypo.latitude),
      lon: nz(hypo.longitude),
      depthKm: nz(hypo.depth),
      magnitude: nz(hypo.magnitude),
    },
    maxIntensity: toIntensity(eq.maxScale),
    domesticTsunami: eq.domesticTsunami ?? null,
    points: (msg.points ?? []).map((p) => ({
      pref: p.pref ?? '',
      addr: p.addr ?? '',
      isArea: p.isArea === true,
      scale: toIntensity(p.scale),
    })),
    receivedAt: receivedAt.toISOString(),
  };
}

const GRADES = new Set<TsunamiGrade>(['MajorWarning', 'Warning', 'Watch', 'Unknown']);

export function parseTsunami(
  msg: P2PTsunami,
  receivedAt: Date,
  homeAreas: readonly string[],
): TsunamiInfo {
  const areas: TsunamiArea[] = (msg.areas ?? []).map((a) => {
    const name = a.name ?? '';
    const grade = (GRADES.has(a.grade as TsunamiGrade) ? a.grade : 'Unknown') as TsunamiGrade;
    return {
      name,
      grade,
      immediate: a.immediate === true,
      firstHeightCondition: a.firstHeight?.condition ?? null,
      firstHeightArrivalTime: toIso(parseJstDateTime(a.firstHeight?.arrivalTime)),
      maxHeightDescription: a.maxHeight?.description ?? null,
      maxHeightValue: nz(a.maxHeight?.value),
      isHome: homeAreas.some((h) => name.includes(h)),
    };
  });
  return {
    id: msg.id ?? `552-${msg.time ?? receivedAt.toISOString()}`,
    issuedAt: toIso(parseJstDateTime(msg.issue?.time ?? msg.time)),
    cancelled: msg.cancelled === true,
    areas,
    affectsHome: areas.some((a) => a.isHome),
    receivedAt: receivedAt.toISOString(),
  };
}

export function parseEewDetection(msg: P2PEewDetection, receivedAt: Date): EewDetection {
  return {
    id: msg.id ?? `554-${msg.time ?? receivedAt.toISOString()}`,
    kind: msg.type ?? 'Full',
    detectedAt: toIso(parseJstDateTime(msg.time)),
    receivedAt: receivedAt.toISOString(),
  };
}

/**
 * 556 は「緊急地震速報(警報)」のみ流れる。予報は含まれないため、
 * ここで作る EewState の alert は常に 'warning'。
 */
export function parseEew(msg: P2PEew, receivedAt: Date): EewState {
  const eq = msg.earthquake ?? {};
  const hypo = eq.hypocenter ?? {};
  const regions: EewRegion[] = (msg.areas ?? []).map((a) => ({
    pref: a.pref ?? '',
    name: a.name ?? '',
    scaleFrom: toIntensity(a.scaleFrom),
    // scaleTo が -1 のときは「〜以上」を意味するので上限なしとして扱う
    scaleTo: a.scaleTo === -1 ? null : toIntensity(a.scaleTo),
    arrivalTime: toIso(parseJstDateTime(a.arrivalTime)),
    condition: a.condition ?? null,
  }));

  const maxIntensity = regions.reduce<IntensityLevel | null>((max, r) => {
    const v = r.scaleTo ?? r.scaleFrom;
    if (v == null) return max;
    return max == null || v > max ? v : max;
  }, null);

  return {
    id: msg.issue?.eventId ?? msg.id ?? `556-${receivedAt.toISOString()}`,
    reportNumber: Number.parseInt(msg.issue?.serial ?? '', 10) || 0,
    // 556 には最終報フラグが無い。続報の打ち切りは保持期間で判断する。
    isFinal: false,
    isCancel: msg.cancelled === true,
    isTraining: msg.test === true,
    isAssumption: (eq.condition ?? '').includes('仮定'),
    alert: 'warning',
    hypocenter: {
      name: hypo.name?.trim() || '不明',
      lat: nz(hypo.latitude),
      lon: nz(hypo.longitude),
      depthKm: nz(hypo.depth),
      magnitude: nz(hypo.magnitude),
    },
    maxIntensity,
    originTime: toIso(parseJstDateTime(eq.originTime)),
    announcedAt: toIso(parseJstDateTime(msg.issue?.time ?? msg.time)),
    receivedAt: receivedAt.toISOString(),
    regions,
    source: 'p2p',
  };
}
