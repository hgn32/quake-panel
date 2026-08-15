type Child = Node | string | number | null | undefined | false;

interface Attributes {
  class?: string;
  text?: string;
  html?: never;
  [key: string]: string | number | boolean | undefined;
}

/**
 * 素の DOM を組み立てるための最小限のヘルパ。
 * テキストは必ず textContent 経由で入れる (innerHTML は使わない)。
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') continue;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function replaceChildren(target: HTMLElement, ...children: Child[]): void {
  target.replaceChildren(
    ...children
      .filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false)
      .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))),
  );
}

export function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素が見つかりません: #${id}`);
  return el as T;
}
