/**
 * P2P地震情報 JSON API v2 の受信形。
 * 2026-08-13 に実データ (https://api.p2pquake.net/v2/history) で確認した形に合わせている。
 */

export interface P2PBase {
  code: number;
  id?: string;
  time?: string;
}

export interface P2PHypocenter {
  name?: string;
  latitude?: number;
  longitude?: number;
  depth?: number;
  magnitude?: number;
  reduceName?: string;
}

/** 551: 地震情報 */
export interface P2PQuake extends P2PBase {
  code: 551;
  issue?: { source?: string; time?: string; type?: string; correct?: string };
  earthquake?: {
    time?: string;
    hypocenter?: P2PHypocenter;
    maxScale?: number;
    domesticTsunami?: string;
    foreignTsunami?: string;
  };
  points?: Array<{ pref?: string; addr?: string; isArea?: boolean; scale?: number }>;
}

/** 552: 津波予報 */
export interface P2PTsunami extends P2PBase {
  code: 552;
  cancelled?: boolean;
  issue?: { source?: string; time?: string; type?: string };
  areas?: Array<{
    grade?: string;
    immediate?: boolean;
    name?: string;
    firstHeight?: { condition?: string; arrivalTime?: string };
    maxHeight?: { description?: string; value?: number };
  }>;
}

/** 554: 緊急地震速報 発表検出 */
export interface P2PEewDetection extends P2PBase {
  code: 554;
  type?: string;
}

/** 556: 緊急地震速報 (警報) */
export interface P2PEew extends P2PBase {
  code: 556;
  test?: boolean;
  cancelled?: boolean;
  issue?: { eventId?: string; serial?: string; time?: string };
  earthquake?: {
    originTime?: string;
    arrivalTime?: string;
    condition?: string;
    hypocenter?: P2PHypocenter;
  };
  areas?: Array<{
    pref?: string;
    name?: string;
    scaleFrom?: number;
    scaleTo?: number;
    kindCode?: string;
    arrivalTime?: string;
    condition?: string;
  }>;
}

export type P2PMessage = P2PQuake | P2PTsunami | P2PEewDetection | P2PEew | P2PBase;

export const P2P_CODES = {
  quake: 551,
  tsunami: 552,
  eewDetection: 554,
  eew: 556,
} as const;
