import { formatJstClock, type TsunamiArea, type TsunamiInfo } from '@quake-panel/shared';
import { h, replaceChildren } from './dom.js';

const GRADE_LABEL: Record<string, string> = {
  MajorWarning: '大津波警報',
  Warning: '津波警報',
  Watch: '津波注意報',
  Unknown: '津波予報',
};

const GRADE_ORDER: Record<string, number> = {
  MajorWarning: 3,
  Warning: 2,
  Watch: 1,
  Unknown: 0,
};

/**
 * 津波予報。利用地 (日向灘沿岸) に関わる予報区を先頭へ出して強調する (§1, §3)。
 */
export class TsunamiPanel {
  constructor(private readonly root: HTMLElement) {}

  update(tsunami: TsunamiInfo | null): void {
    if (!tsunami || tsunami.cancelled || tsunami.areas.length === 0) {
      this.root.hidden = true;
      replaceChildren(this.root);
      return;
    }
    this.root.hidden = false;

    const sorted = [...tsunami.areas].sort((a, b) => {
      if (a.isHome !== b.isHome) return a.isHome ? -1 : 1;
      return (GRADE_ORDER[b.grade] ?? 0) - (GRADE_ORDER[a.grade] ?? 0);
    });
    const top = sorted[0];
    this.root.dataset['grade'] = top ? top.grade : 'Unknown';

    replaceChildren(
      this.root,
      h(
        'div',
        { class: 'tsunami__head' },
        h('h2', { class: 'panel__title', text: top ? GRADE_LABEL[top.grade] ?? '津波予報' : '津波予報' }),
        h('span', {
          class: 'tsunami__issued',
          text: tsunami.issuedAt ? `${formatJstClock(tsunami.issuedAt)} 発表` : '',
        }),
      ),
      tsunami.affectsHome
        ? h('p', { class: 'tsunami__home', text: '⚠ 利用地の沿岸が対象に含まれています' })
        : null,
      h('ul', { class: 'tsunami-list' }, ...sorted.map((area) => renderArea(area))),
    );
  }
}

function renderArea(area: TsunamiArea): HTMLElement {
  const detail = [
    area.maxHeightDescription ? `予想 ${area.maxHeightDescription}` : null,
    area.immediate ? '直ちに来襲' : null,
    area.firstHeightCondition,
    area.firstHeightArrivalTime ? `${formatJstClock(area.firstHeightArrivalTime)} 到達予測` : null,
  ]
    .filter(Boolean)
    .join(' / ');

  return h(
    'li',
    { class: `tsunami-list__item${area.isHome ? ' tsunami-list__item--home' : ''}` },
    h('span', { class: `grade-chip grade-chip--${area.grade}`, text: GRADE_LABEL[area.grade] ?? '予報' }),
    h('span', { class: 'tsunami-list__name', text: area.name }),
    detail ? h('span', { class: 'tsunami-list__detail', text: detail }) : null,
  );
}
