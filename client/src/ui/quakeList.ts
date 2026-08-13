import {
  formatJstDateTime,
  intensityColor,
  intensityLabel,
  intensityTextColor,
  type QuakeInfo,
} from '@quake-panel/shared';
import { h, replaceChildren } from './dom.js';

const ISSUE_LABEL: Record<string, string> = {
  ScalePrompt: '震度速報',
  Destination: '震源に関する情報',
  ScaleAndDestination: '震源・震度情報',
  DetailScale: '各地の震度',
  Foreign: '遠地地震',
  Other: 'その他',
};

/**
 * 地震情報の履歴。
 *
 * 利用地付近の震度は、ここに出る気象庁発表の実測値で確認する。
 * 強震モニタ画像の色から震度を推定する処理は規約上行わない (§2(2), Phase 4 除外)。
 */
export class QuakeList {
  /** 展開して各地の震度を出している地震。1 件だけ開く。 */
  private expandedId: string | null = null;
  private quakes: QuakeInfo[] = [];
  private limit = 6;

  /** homeHints は利用地の手掛かり (例: ["東京都"])。前にあるものほど優先。 */
  constructor(
    private readonly root: HTMLElement,
    private homeHints: readonly string[],
  ) {}

  /** 利用地はサーバーの現況一括で分かるので、接続後に差し替える */
  setHomeHints(hints: readonly string[]): void {
    this.homeHints = hints;
  }

  update(quakes: QuakeInfo[], limit: number): void {
    this.quakes = quakes;
    this.limit = limit;
    this.render();
  }

  private render(): void {
    if (this.quakes.length === 0) {
      replaceChildren(this.root, h('li', { class: 'quake-list__empty', text: '地震情報はありません' }));
      return;
    }
    replaceChildren(this.root, ...this.quakes.slice(0, this.limit).map((q) => this.renderItem(q)));
  }

  /** 押したら各地の震度を開く。もう一度押すと閉じる。 */
  private toggle(id: string): void {
    this.expandedId = this.expandedId === id ? null : id;
    this.render();
  }

  private renderItem(quake: QuakeInfo): HTMLElement {
    const expanded = this.expandedId === quake.id;
    const chip = h('span', {
      class: 'quake-list__scale',
      text: intensityLabel(quake.maxIntensity) ?? '-',
    });
    chip.style.background = intensityColor(quake.maxIntensity);
    chip.style.color = intensityTextColor(quake.maxIntensity);

    const homePoint = this.findHomePoint(quake);

    const item = h(
      'li',
      { class: 'quake-list__item', title: '押すと各地の震度を開きます' },
      chip,
      h(
        'div',
        { class: 'quake-list__body' },
        h('div', {
          class: 'quake-list__place',
          // 震度速報では震源が未確定。「不明」と出すより発表種別で見せたほうが分かりやすい。
          text: quake.hypocenter.name !== '不明' ? quake.hypocenter.name : '震源調査中',
        }),
        h(
          'div',
          { class: 'quake-list__meta' },
          h('span', { text: formatJstDateTime(quake.occurredAt ?? quake.issuedAt) }),
          h('span', {
            text: quake.hypocenter.magnitude != null ? `M${quake.hypocenter.magnitude.toFixed(1)}` : 'M--',
          }),
          h('span', {
            text: quake.hypocenter.depthKm != null ? `深さ${quake.hypocenter.depthKm}km` : '深さ--',
          }),
          h('span', { class: 'quake-list__type', text: ISSUE_LABEL[quake.issueType] ?? quake.issueType }),
          h('span', {
            class: 'quake-list__toggle',
            text: expanded ? '▾ 閉じる' : `▸ 各地の震度 ${quake.points.length}件`,
          }),
        ),
        homePoint
          ? h('div', {
              class: 'quake-list__home',
              // 何の行か分かるように、どの県の話かを必ず書く
              text: `${homePoint.hint}の最大 ${homePoint.addr} 震度${intensityLabel(homePoint.scale) ?? '-'}`,
              title: '利用地の都道府県で、この地震の震度がいちばん大きかった観測点',
            })
          : null,
        quake.domesticTsunami === 'Warning' || quake.domesticTsunami === 'Watch'
          ? h('div', { class: 'quake-list__tsunami', text: '津波情報あり' })
          : null,
        expanded ? this.renderPoints(quake) : null,
      ),
    );
    item.addEventListener('click', () => this.toggle(quake.id));
    return item;
  }

  /**
   * 各地の震度。震度の強い順にまとめて出す。
   *
   * 「震度速報」の段階では市区町村ごとの値がまだ無く、地域名だけが来る。
   * その場合は観測点が無いことをそのまま書く (押しても何も出ない、を避ける)。
   */
  private renderPoints(quake: QuakeInfo): HTMLElement {
    if (quake.points.length === 0) {
      return h('div', {
        class: 'quake-list__note',
        text: 'この発表には各地の震度がまだ含まれていません (続報で入ります)。',
      });
    }
    const byScale = new Map<number | null, string[]>();
    for (const point of quake.points) {
      const names = byScale.get(point.scale) ?? [];
      names.push(point.addr);
      byScale.set(point.scale, names);
    }
    const rows = [...byScale.entries()]
      .sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1))
      .map(([scale, names]) => {
        const label = h('span', {
          class: 'quake-list__point-scale',
          text: intensityLabel(scale) ?? '-',
        });
        label.style.background = intensityColor(scale);
        label.style.color = intensityTextColor(scale);
        return h(
          'div',
          { class: 'quake-list__point' },
          label,
          h('span', {
            class: 'quake-list__point-names',
            text: names.join('、'),
            title: names.join('、'),
          }),
        );
      });
    return h('div', { class: 'quake-list__points' }, ...rows);
  }

  /**
   * 利用地の観測点があれば拾って前に出す。手掛かりの並び順で優先度が決まる。
   *
   * 手掛かりは県名までしか無く (地名は設定させない)、観測点に座標も付いて
   * こないため、同じ県内で複数該当したときは最も揺れた点を採る。
   */
  private findHomePoint(
    quake: QuakeInfo,
  ): { hint: string; addr: string; scale: number | null } | null {
    for (const hint of this.homeHints) {
      let best: { hint: string; addr: string; scale: number | null } | null = null;
      for (const point of quake.points) {
        if (point.isArea) continue;
        if (!point.addr.includes(hint) && !point.pref.includes(hint)) continue;
        if (!best || (point.scale ?? -1) > (best.scale ?? -1)) {
          best = { hint, addr: point.addr, scale: point.scale };
        }
      }
      if (best) return best;
    }
    return null;
  }
}
