import {
  EEW_RADIUS_CHOICES,
  KMONI_LAYERS,
  KMONI_LAYER_LABELS,
  KMONI_LAYER_NOTES,
  MIN_INTENSITY_CHOICES,
  TSUNAMI_ALERT_MIN_CHOICES,
  geolocationErrorMessage,
  type DemoScenario,
  type HomeLocation,
  type KmoniLayer,
} from '@quake-panel/shared';
import type { Settings } from '../settings.js';
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

/** デモ再生のシナリオとボタンの表記 */
const DEMO_SCENARIOS: ReadonlyArray<{ value: DemoScenario; label: string }> = [
  { value: 'forecast', label: '予報' },
  { value: 'warning', label: '警報へ格上げ' },
  { value: 'cancel', label: 'キャンセル報' },
  { value: 'tsunami', label: '津波予報' },
];

export interface SettingsPanelDeps {
  modal: HTMLElement;
  form: HTMLElement;
  openButton: HTMLElement;
  closeButton: HTMLElement;
  cancelButton: HTMLElement;
  getSettings: () => Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** 音と画面明滅の両方を出すテスト */
  onTest: () => void;
  /** デモ再生の発火。実行が確定した後に呼ばれる */
  onDemo: (scenario: DemoScenario) => void;
  /** 地図をクリックして利用地を選ぶモードに入る */
  onPickHome: () => void;
  /** ブラウザの位置情報が使えるか (HTTPS でないと使えないのでボタンごと隠す) */
  canUseCurrentLocation: () => boolean;
  /** その端末の現在地 */
  requestCurrentLocation: () => Promise<HomeLocation>;
  /** 自動設定のときに、いま効いている予報区を見せるために使う */
  describeTsunamiAreas: () => string;
  /** 絞り込みで隠れている地震の件数 */
  hiddenQuakeCount: () => number;
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
  /** 「実行する/やめる」の確認待ちになっているシナリオ。null なら通常表示。 */
  private pendingDemo: DemoScenario | null = null;

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
    this.pendingDemo = null;
    this.render();
    this.deps.modal.hidden = false;
  }

  /** 変更はすでに効いているので、閉じるだけ */
  private save(): void {
    this.snapshot = null;
    this.pendingDemo = null;
    this.deps.modal.hidden = true;
  }

  /** 開いた時点の値へ戻して閉じる */
  private cancel(): void {
    if (this.snapshot) this.deps.onChange(this.snapshot);
    this.snapshot = null;
    this.pendingDemo = null;
    this.deps.modal.hidden = true;
  }

  /** 明滅を見せるためにいったん閉じる (取消扱いにはしない) */
  close(): void {
    this.snapshot = null;
    this.pendingDemo = null;
    this.deps.modal.hidden = true;
  }

  /**
   * 章立てで組む。
   *
   * 項目が増えて一列に並べると、何を触っているのか分からなくなる。
   * 「利用地」「リアルタイム表示」「地震速報」「津波予報」「履歴パネル」「音と明滅」の
   * 6 つに分け、各章の中は「ラベル + 説明」と「操作部」の 2 列で揃える。
   *
   * 表示 (パネル・地図) は常に全国分を出す。音・明滅だけを利用地との関わりで絞る、
   * という設計を「地震速報」「津波予報」の章の説明文に反映してある。
   */
  private render(): void {
    const settings = this.deps.getSettings();
    replaceChildren(
      this.deps.form,
      this.section(
        '利用地',
        '地図の初期位置と、地震速報・津波・履歴の「自分に関わるか」の判定に使います。',
        this.homeRow(settings),
      ),
      this.section(
        'リアルタイム表示',
        null,
        this.layerRow(settings),
        this.checkboxRow(
          '表示位置を固定',
          '地図の操作と、地震情報との境目のドラッグを受け付けなくします。常時表示の端末向け。',
          settings.locked,
          (checked) => this.deps.onChange({ locked: checked }),
        ),
      ),
      this.section(
        '地震速報',
        'サーバーは常に全国の予報・警報を受信し、パネルと地図には全国分を表示します。音と明滅だけをここで絞れます。',
        this.radioRow(
          '音・明滅を出す速報',
          '警報は、警報対象地域に利用地の県が入っているかで判定します。',
          [
            { value: 'home', label: '利用地に関わるもののみ', checked: settings.eewScope === 'home' },
            { value: 'national', label: '全国すべて', checked: settings.eewScope === 'national' },
          ],
          (value) => {
            this.deps.onChange({ eewScope: value === 'national' ? 'national' : 'home' });
            // 速報の範囲によって震央距離の行の disabled が変わるため引き直す
            this.render();
          },
        ),
        this.selectRow(
          '「関わる」とみなす震央距離',
          '対象地域の情報が無い予報は、震央からの距離で判定します。距離は判定にだけ使い、揺れや到達時刻の予測はしません。',
          settings.eewRadiusKm,
          EEW_RADIUS_CHOICES,
          (value) => this.deps.onChange({ eewRadiusKm: value }),
          settings.eewScope === 'national',
        ),
        this.radioRow(
          '音・明滅を出す下限',
          '気象庁の基準で、震度5弱以上の強い揺れが予想される地域がある場合は「警報」、それに満たない場合は「予報」として発表されます。',
          [
            { value: 'all', label: '予報から出す', checked: settings.notifyForecast },
            { value: 'warning', label: '警報のみ', checked: !settings.notifyForecast },
          ],
          (value) => this.deps.onChange({ notifyForecast: value === 'all' }),
        ),
      ),
      this.section(
        '津波予報',
        '発表は常にパネルと地図に表示します。音と明滅は、自分の予報区が対象のときだけ出します。',
        this.tsunamiRow(settings),
        this.selectRow(
          '音・明滅を出す下限',
          '高さの予想で4段階あります: 大津波警報(3m超)／津波警報(1m超3m以下)／' +
            '津波注意報(20cm以上1m以下)／津波予報(20cm未満)。',
          settings.tsunamiAlertMin,
          TSUNAMI_ALERT_MIN_CHOICES,
          (value) => this.deps.onChange({ tsunamiAlertMin: value }),
        ),
        this.checkboxRow(
          '利用地以外だけの大津波警報も知らせる',
          '自分の予報区が対象外でも、どこかに大津波警報が出ていれば音と明滅を出します。' +
            '「出さない」を選んでいるときは効きません。',
          settings.tsunamiNationalMajor,
          (checked) => this.deps.onChange({ tsunamiNationalMajor: checked }),
        ),
      ),
      this.section(
        '履歴パネル',
        '気象庁発表の事後の地震情報です。表示を絞るだけで、音・明滅は出しません。',
        this.quakeFilterRow(settings),
        this.numberRow('履歴の表示件数', settings.historyCount, 3, 12, (value) =>
          this.deps.onChange({ historyCount: value }),
        ),
      ),
      // EEW 専用ではなく津波の音・明滅にも共通する章なので「音と明滅」という章名にする
      this.section(
        '音と明滅',
        null,
        this.sliderRow(
          '音量',
          null,
          { value: settings.volume, min: 0, max: 1, step: 0.05 },
          (value) => `${Math.round(value * 100)}%`,
          (value) => this.deps.onChange({ volume: value }),
        ),
        this.secondsRow(
          '音を鳴らす時間',
          '発表が続いていても、この時間で音だけ止めます。',
          settings.soundSeconds,
          [
            { value: 5, label: '5秒' },
            { value: 10, label: '10秒' },
            { value: 20, label: '20秒' },
            { value: 30, label: '30秒' },
            { value: 0, label: '鳴らし切る' },
          ],
          (value) => this.deps.onChange({ soundSeconds: value }),
        ),
        this.secondsRow(
          '画面明滅を続ける時間',
          '同じく、この時間で明滅だけ止めます。発表のパネル表示は消えません。',
          settings.flashSeconds,
          [
            { value: 15, label: '15秒' },
            { value: 30, label: '30秒' },
            { value: 60, label: '60秒' },
            { value: 180, label: '3分' },
            { value: 0, label: '止めない' },
          ],
          (value) => this.deps.onChange({ flashSeconds: value }),
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
        this.demoRow(),
      ),
      // 常時表示の画面には出さず、問い合わせを受けたときにどのビルドか
      // 特定できるよう、設定画面の最下部にだけ小さく出す。
      this.versionFooter(),
    );
  }

  /**
   * デモ再生。
   *
   * ボタンを押しても即発火はさせず、いったん行内を警告表示に切り替えて
   * 「実行する」を押させてから初めて送信する (window.confirm は使わない)。
   */
  private demoRow(): HTMLElement {
    if (this.pendingDemo) {
      const scenario = this.pendingDemo;
      const label = DEMO_SCENARIOS.find((s) => s.value === scenario)?.label ?? scenario;
      return this.row(
        'デモ再生',
        null,
        h(
          'div',
          { class: 'settings__stack' },
          h('p', {
            class: 'settings__warning',
            text:
              `「${label}」のデモを実行します。接続中のすべての端末で、本物と同じ音と画面明滅が` +
              '鳴ります。実行しますか?',
          }),
          h(
            'div',
            { class: 'settings__options' },
            this.button('実行する', () => {
              this.pendingDemo = null;
              // 明滅は画面全体に出るので、確認できるよう設定画面を閉じる (テストボタンと同じ流儀)
              this.close();
              this.deps.onDemo(scenario);
            }),
            this.button('やめる', () => {
              this.pendingDemo = null;
              this.render();
            }),
          ),
        ),
      );
    }

    return this.row(
      'デモ再生',
      '実際の電文と同じ形のデモを全端末に流します。実発生時はデモを即中止して本物を優先します。',
      h(
        'div',
        { class: 'settings__options' },
        ...DEMO_SCENARIOS.map((scenario) =>
          this.button(scenario.label, () => {
            this.pendingDemo = scenario.value;
            this.render();
          }),
        ),
      ),
    );
  }

  /** ビルド時のコミットハッシュ。vite.config.ts の define で埋め込まれる。 */
  private versionFooter(): HTMLElement {
    const label = __COMMIT_HASH__ ? `バージョン: ${__COMMIT_HASH__}` : 'バージョン: 開発版';
    return h('p', { class: 'settings__version', text: label });
  }

  /** 章。見出しと、必要なら章全体の説明を付ける。 */
  private section(title: string, hint: string | null, ...rows: HTMLElement[]): HTMLElement {
    return h(
      'section',
      { class: 'settings__section' },
      h(
        'div',
        { class: 'settings__section-head' },
        h('h3', { class: 'settings__section-title', text: title }),
        hint ? h('span', { class: 'settings__hint', text: hint }) : null,
      ),
      ...rows,
    );
  }

  /** 秒数の選択。音と明滅で形をそろえる。 */
  private secondsRow(
    label: string,
    hint: string | null,
    value: number,
    choices: ReadonlyArray<{ value: number; label: string }>,
    onSelect: (value: number) => void,
  ): HTMLElement {
    const select = h('select', { class: 'settings__select' });
    choices.forEach((choice) => {
      const option = h('option', { value: String(choice.value), text: choice.label });
      option.selected = choice.value === value;
      select.append(option);
    });
    select.addEventListener('change', () => onSelect(Number(select.value)));
    return this.row(label, hint, select);
  }

  /**
   * 値の選択 (select)。数値・文字列いずれの選択肢にも使えるようにしてある
   * (震央距離は数値、津波の下限グレードは文字列)。
   */
  private selectRow<T extends string | number>(
    label: string,
    hint: string | null,
    value: T,
    choices: ReadonlyArray<{ value: T; label: string }>,
    onSelect: (value: T) => void,
    disabled = false,
  ): HTMLElement {
    const select = h('select', { class: 'settings__select' });
    choices.forEach((choice) => {
      const option = h('option', { value: String(choice.value), text: choice.label });
      option.selected = choice.value === value;
      select.append(option);
    });
    select.disabled = disabled;
    select.addEventListener('change', () => {
      const found = choices.find((choice) => String(choice.value) === select.value);
      if (found) onSelect(found.value);
    });
    return this.row(label, hint, select);
  }

  /** 地図に出す指標。この端末だけで変えられる。 */
  private layerRow(settings: Settings): HTMLElement {
    const options = KMONI_LAYERS.map((layer) => ({
      value: layer,
      label: KMONI_LAYER_LABELS[layer],
      checked: settings.layer === layer,
    }));
    return h(
      'div',
      { class: 'settings__row' },
      h(
        'div',
        { class: 'settings__label' },
        h('span', { text: '地図に出す指標' }),
        h('span', {
          class: 'settings__hint',
          text: 'リアルタイム震度以外を選ぶと、その分だけサーバーが追加で取得します。',
        }),
      ),
      h(
        'div',
        { class: 'settings__stack' },
        this.radioGroup('kmoni-layer', options, (value) => {
          this.deps.onChange({ layer: value as KmoniLayer });
          this.render();
        }),
        // 選んだものの性格は操作部の下に出す (ラベル側に説明を 2 つ積むと窮屈)
        h('span', {
          class: 'settings__hint settings__hint--note',
          text: KMONI_LAYER_NOTES[settings.layer],
        }),
      ),
    );
  }

  /** 地震情報の絞り込み。全国の小さな地震で履歴が埋まるのを防ぐ。 */
  private quakeFilterRow(settings: Settings): HTMLElement {
    const filter = settings.quakeFilter;
    const select = h('select', { class: 'settings__select' });
    MIN_INTENSITY_CHOICES.forEach((choice) => {
      const option = h('option', { value: String(choice.value), text: choice.label });
      option.selected = choice.value === filter.minIntensity;
      select.append(option);
    });
    select.addEventListener('change', () => {
      this.deps.onChange({
        quakeFilter: { ...this.deps.getSettings().quakeFilter, minIntensity: Number(select.value) },
      });
      this.render();
    });

    const only = h('input', { type: 'checkbox' });
    only.checked = filter.homePrefectureOnly;
    only.addEventListener('change', () => {
      this.deps.onChange({
        quakeFilter: { ...this.deps.getSettings().quakeFilter, homePrefectureOnly: only.checked },
      });
      this.render();
    });

    const hidden = this.deps.hiddenQuakeCount();
    return h(
      'div',
      { class: 'settings__row' },
      h(
        'div',
        { class: 'settings__label' },
        h('span', { text: '履歴に出す地震' }),
        h('span', {
          class: 'settings__hint',
          text:
            hidden > 0
              ? `いまの条件で ${hidden} 件を隠しています。`
              : '小さな地震や、自分の県が揺れていない地震を隠せます。',
        }),
      ),
      h(
        'div',
        { class: 'settings__stack' },
        h('label', { class: 'settings__option' }, h('span', { text: '最大震度' }), select),
        h(
          'label',
          { class: 'settings__option' },
          only,
          h('span', { text: '利用地の都道府県で揺れたものだけ' }),
        ),
      ),
    );
  }

  /**
   * 利用地。
   *
   * 決め方は 3 つ (直接入力 / 地図をクリック / 現在地)。
   * 自動取得はどれも「入力欄へ入れる」までで、確定は「保存」に任せる
   * (取消で開いた時点へ戻せる)。
   */
  private homeRow(settings: Settings): HTMLElement {
    const lat = this.coordInput(settings.home.lat, -90, 90, (value) =>
      this.deps.onChange({ home: { ...this.deps.getSettings().home, lat: value } }),
    );
    const lon = this.coordInput(settings.home.lon, -180, 180, (value) =>
      this.deps.onChange({ home: { ...this.deps.getSettings().home, lon: value } }),
    );
    const pick = this.button('地図から選ぶ', () => {
      this.close();
      this.deps.onPickHome();
    });

    const status = h('span', { class: 'settings__hint' });
    const fill = (home: HomeLocation): void => {
      lat.value = home.lat.toFixed(4);
      lon.value = home.lon.toFixed(4);
      this.deps.onChange({ home });
      status.textContent =
        `${home.lat.toFixed(4)}, ${home.lon.toFixed(4)} にしました。` +
        '「保存」で確定、「取消」で元に戻ります。';
    };

    const buttons: HTMLElement[] = [pick];
    if (this.deps.canUseCurrentLocation()) {
      buttons.push(
        this.loadButton('現在地を取得', status, () => this.deps.requestCurrentLocation(), fill, (error) =>
          // 位置情報 API のエラーは code で理由が分かる
          geolocationErrorMessage(typeof error.code === 'number' ? error.code : null),
        ),
      );
    }
    return h(
      'div',
      { class: 'settings__row' },
      h(
        'div',
        { class: 'settings__label' },
        h('span', { text: '利用地' }),
        h('span', {
          class: 'settings__hint',
          text: '地図の中心と、速報・津波・履歴の判定に使います。',
        }),
        status,
      ),
      h(
        'div',
        { class: 'settings__stack' },
        h(
          'div',
          { class: 'settings__options' },
          h('label', { class: 'settings__coord' }, h('span', { text: '緯度' }), lat),
          h('label', { class: 'settings__coord' }, h('span', { text: '経度' }), lon),
        ),
        h('div', { class: 'settings__options' }, ...buttons),
      ),
    );
  }

  /**
   * 押すと非同期に値を取りに行くボタン。
   *
   * 取得中は押せなくし、結果 (成功・失敗・未設定) は必ず文言で返す。
   * 押しても何も起きないように見えるのが一番困るため。
   */
  private loadButton(
    label: string,
    status: HTMLElement,
    load: () => Promise<HomeLocation | null>,
    onLoaded: (home: HomeLocation) => void,
    describeError: (error: { code?: number }) => string,
    emptyMessage = '取得できませんでした。',
  ): HTMLButtonElement {
    const button = this.button(label, () => {
      button.disabled = true;
      status.textContent = `${label}…`;
      load()
        .then((home) => {
          if (home) onLoaded(home);
          else status.textContent = emptyMessage;
        })
        .catch((error: { code?: number }) => {
          status.textContent = describeError(error);
        })
        .finally(() => {
          button.disabled = false;
        });
    });
    return button;
  }

  /**
   * 津波予報区。
   *
   * 既定は利用地の都道府県から決める (予報区名は「宮崎県」「東京湾内湾」のように
   * 県名と一致しないものもあるため、県ごとの補助表を使う)。
   * 手動にすると県を複数選べる。
   */
  private tsunamiRow(settings: Settings): HTMLElement {
    const auto = settings.tsunamiMode === 'auto';

    const select = h('select', { class: 'settings__select', multiple: 'multiple' });
    PREFECTURES.forEach((name) => {
      const option = h('option', { value: name, text: name });
      option.selected = settings.tsunamiAreas.some(
        (area) => area.includes(name) || name.includes(area),
      );
      select.append(option);
    });
    select.disabled = auto;
    const hint = h('span', { class: 'settings__hint' });
    const renderHint = (): void => {
      hint.textContent = `いま強調する予報区: ${this.deps.describeTsunamiAreas()}`;
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

    renderHint();
    return h(
      'div',
      { class: 'settings__row' },
      h(
        'div',
        { class: 'settings__label' },
        h('span', { text: '自分の予報区' }),
        hint,
      ),
      h('div', { class: 'settings__stack' }, mode, select),
    );
  }

  private coordInput(
    value: number,
    min: number,
    max: number,
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
