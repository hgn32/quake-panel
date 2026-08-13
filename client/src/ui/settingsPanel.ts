import type { Settings, UrlKey } from '../settings.js';
import { h, replaceChildren } from './dom.js';

/** 津波予報区を手で選ぶときの選択肢。予報区名は県名を含むものが多いので県で選ばせる。 */
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

export interface SettingsPanelDeps {
  modal: HTMLElement;
  form: HTMLElement;
  openButton: HTMLElement;
  closeButton: HTMLElement;
  cancelButton: HTMLElement;
  getSettings: () => Settings;
  /** URL で固定されている項目は編集させない */
  isFixedByUrl: (key: UrlKey) => boolean;
  onChange: (patch: Partial<Settings>) => void;
  /** 音と画面明滅の両方を出すテスト */
  onTest: () => void;
  /** 地図をクリックして利用地を選ぶモードに入る */
  onPickHome: () => void;
  /** 自動設定のときに、いま効いている予報区を見せるために使う */
  describeTsunamiAreas: () => string;
}

/**
 * 端末ごとの設定 UI。
 *
 * 変更はその場で効く (音量やテストは効かせないと確認できない)。
 * ただし開いた時点の値を控えておき、「取消」で元へ戻せるようにしてある。
 * ここで決めるのは「この端末での鳴らし方・見せ方」だけで、サーバーの挙動は変えない (§3)。
 */
export class SettingsPanel {
  private snapshot: Settings | null = null;

  constructor(private readonly deps: SettingsPanelDeps) {
    deps.openButton.addEventListener('click', () => this.open());
    deps.closeButton.addEventListener('click', () => this.save());
    deps.cancelButton.addEventListener('click', () => this.cancel());
    deps.modal.addEventListener('click', (ev) => {
      if (ev.target === deps.modal) this.cancel();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !deps.modal.hidden) this.cancel();
    });
  }

  open(): void {
    this.snapshot = { ...this.deps.getSettings() };
    this.render();
    this.deps.modal.hidden = false;
  }

  /** 変更はすでに効いているので、閉じるだけ */
  private save(): void {
    this.snapshot = null;
    this.deps.modal.hidden = true;
  }

  /** 開いた時点の値へ戻して閉じる */
  private cancel(): void {
    if (this.snapshot) this.deps.onChange(this.snapshot);
    this.snapshot = null;
    this.deps.modal.hidden = true;
  }

  /** 明滅を見せるためにいったん閉じる (取消扱いにはしない) */
  close(): void {
    this.snapshot = null;
    this.deps.modal.hidden = true;
  }

  private render(): void {
    const settings = this.deps.getSettings();
    replaceChildren(
      this.deps.form,
      this.radioRow(
        'EEW の通知範囲',
        'この端末で音と明滅を出す範囲。サーバーは常に予報も警報も受信しています。',
        [
          { value: 'all', label: '予報から通知', checked: settings.notifyForecast },
          { value: 'warning', label: '警報のみ通知', checked: !settings.notifyForecast },
        ],
        (value) => this.deps.onChange({ notifyForecast: value === 'all' }),
      ),
      this.sliderRow(
        '音量',
        null,
        { value: settings.volume, min: 0, max: 1, step: 0.05 },
        (value) => `${Math.round(value * 100)}%`,
        (value) => this.deps.onChange({ volume: value }),
      ),
      this.row(
        'テスト',
        '実際の警報と同じ音と画面明滅を数秒だけ出します。',
        this.button('音と明滅をテスト', () => {
          // 明滅は画面全体に出るので、確認できるよう設定画面を閉じる
          this.close();
          this.deps.onTest();
        }),
      ),
      this.homeRow(settings),
      this.tsunamiRow(settings),
      this.checkboxRow(
        '表示位置を固定',
        '地図のホイール操作とドラッグを受け付けなくします。常時表示の端末で誤って動かさないため。',
        settings.locked,
        (checked) => this.deps.onChange({ locked: checked }),
      ),
      this.checkboxRow(
        '観測点を発光表示',
        '拡大時の粗さが目立たなくなります。動作が重い場合は切ってください。',
        settings.glow,
        (checked) => this.deps.onChange({ glow: checked }),
      ),
      this.numberRow('履歴の表示件数', settings.historyCount, 3, 12, (value) =>
        this.deps.onChange({ historyCount: value }),
      ),
    );
  }

  /** 利用地。数値の直接入力と、地図から選ぶ方法の両方を用意する。 */
  private homeRow(settings: Settings): HTMLElement {
    const fixed = this.deps.isFixedByUrl('home');
    const lat = this.coordInput(settings.home.lat, -90, 90, fixed, (value) =>
      this.deps.onChange({ home: { ...this.deps.getSettings().home, lat: value } }),
    );
    const lon = this.coordInput(settings.home.lon, -180, 180, fixed, (value) =>
      this.deps.onChange({ home: { ...this.deps.getSettings().home, lon: value } }),
    );
    const pick = this.button('地図から選ぶ', () => {
      this.close();
      this.deps.onPickHome();
    });
    pick.disabled = fixed;
    return this.row(
      '利用地',
      fixed
        ? 'URL で指定されているため変更できません。'
        : '地図の中心と、地震情報の履歴で自分の県を前に出すのに使います。',
      h(
        'div',
        { class: 'settings__options' },
        h('label', { class: 'settings__coord' }, h('span', { text: '緯度' }), lat),
        h('label', { class: 'settings__coord' }, h('span', { text: '経度' }), lon),
        pick,
      ),
    );
  }

  /**
   * 津波予報区。
   *
   * 既定は利用地の都道府県から決める (予報区名は「宮崎県」「東京湾内湾」のように
   * 県名と一致しないものもあるため、県ごとの補助表を使う)。
   * 手動にすると県を複数選べる。
   */
  private tsunamiRow(settings: Settings): HTMLElement {
    const fixed = this.deps.isFixedByUrl('tsunamiAreas');
    const auto = settings.tsunamiMode === 'auto' && !fixed;

    const select = h('select', { class: 'settings__select', multiple: 'multiple' });
    for (const name of PREFECTURES) {
      const option = h('option', { value: name, text: name });
      option.selected = settings.tsunamiAreas.some((area) => area.includes(name) || name.includes(area));
      select.append(option);
    }
    select.disabled = auto || fixed;
    const hint = h('span', { class: 'settings__hint' });
    const renderHint = (): void => {
      hint.textContent = fixed
        ? 'URL で指定されているため変更できません。'
        : `いま強調する予報区: ${this.deps.describeTsunamiAreas()}`;
    };
    select.addEventListener('change', () => {
      const areas = [...select.selectedOptions].map((option) => option.value);
      this.deps.onChange({ tsunamiAreas: areas });
      // 選び直した結果をその場で見せる (再描画すると選択操作を邪魔するため文言だけ差し替える)
      renderHint();
    });

    const mode = this.radioGroup(
      'tsunami-mode',
      [
        { value: 'auto', label: '利用地から自動', checked: auto },
        { value: 'manual', label: '自分で選ぶ', checked: !auto },
      ],
      (value) => {
        this.deps.onChange({ tsunamiMode: value === 'auto' ? 'auto' : 'manual' });
        this.render();
      },
    );
    if (fixed) {
      for (const input of mode.querySelectorAll('input')) input.disabled = true;
    }

    renderHint();
    return h(
      'div',
      { class: 'settings__row' },
      h(
        'div',
        { class: 'settings__label' },
        h('span', { text: '強調する津波予報区' }),
        hint,
      ),
      h('div', { class: 'settings__stack' }, mode, select),
    );
  }

  private coordInput(
    value: number,
    min: number,
    max: number,
    disabled: boolean,
    onChange: (value: number) => void,
  ): HTMLInputElement {
    const input = h('input', {
      type: 'number',
      class: 'settings__number',
      min: String(min),
      max: String(max),
      step: '0.001',
    });
    input.value = String(value);
    input.disabled = disabled;
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (!Number.isFinite(next) || next < min || next > max) {
        input.value = String(value);
        return;
      }
      onChange(next);
    });
    return input;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = h('button', { class: 'button', type: 'button', text: label });
    button.addEventListener('click', onClick);
    return button;
  }

  private radioGroup(
    name: string,
    options: Array<{ value: string; label: string; checked: boolean }>,
    onSelect: (value: string) => void,
  ): HTMLElement {
    return h(
      'div',
      { class: 'settings__options' },
      ...options.map((option) => {
        const input = h('input', { type: 'radio', name, value: option.value });
        input.checked = option.checked;
        input.addEventListener('change', () => {
          if (input.checked) onSelect(option.value);
        });
        return h('label', { class: 'settings__option' }, input, h('span', { text: option.label }));
      }),
    );
  }

  private radioRow(
    label: string,
    hint: string | null,
    options: Array<{ value: string; label: string; checked: boolean }>,
    onSelect: (value: string) => void,
  ): HTMLElement {
    return this.row(label, hint, this.radioGroup(`radio-${label}`, options, onSelect));
  }

  private checkboxRow(
    label: string,
    hint: string | null,
    checked: boolean,
    onToggle: (checked: boolean) => void,
  ): HTMLElement {
    const input = h('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onToggle(input.checked));
    return this.row(label, hint, h('label', { class: 'settings__option' }, input));
  }

  private sliderRow(
    label: string,
    hint: string | null,
    range: { value: number; min: number; max: number; step: number },
    format: (value: number) => string,
    onInput: (value: number) => void,
  ): HTMLElement {
    const input = h('input', {
      type: 'range',
      min: String(range.min),
      max: String(range.max),
      step: String(range.step),
    });
    input.value = String(range.value);
    const readout = h('span', { class: 'settings__readout', text: format(range.value) });
    input.addEventListener('input', () => {
      const next = Number(input.value);
      readout.textContent = format(next);
      onInput(next);
    });
    return this.row(label, hint, h('div', { class: 'settings__options' }, input, readout));
  }

  private numberRow(
    label: string,
    value: number,
    min: number,
    max: number,
    onInput: (value: number) => void,
  ): HTMLElement {
    const input = h('input', { type: 'number', min: String(min), max: String(max) });
    input.value = String(value);
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (Number.isFinite(next)) onInput(Math.min(Math.max(next, min), max));
    });
    return this.row(label, null, input);
  }

  private row(label: string, hint: string | null, control: HTMLElement): HTMLElement {
    return h(
      'div',
      { class: 'settings__row' },
      h(
        'div',
        { class: 'settings__label' },
        h('span', { text: label }),
        hint ? h('span', { class: 'settings__hint', text: hint }) : null,
      ),
      control,
    );
  }
}
