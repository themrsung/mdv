/**
 * A minimal DOM, for testing the DOM output path.
 *
 * jsdom is not a dependency of this repo and adding one during a concurrent
 * build is not on (CONTRACTS §1.2), so the handful of interfaces `dom.ts`
 * actually touches are implemented here instead. That is viable precisely
 * because `toSvgElement` and `createSvgRenderer` take an **injected**
 * `Document`: the backend never reaches for a global, so a synthetic document
 * is a first-class caller rather than a hack.
 *
 * This is a test double, not a DOM implementation. It models element identity,
 * attributes (including the XML namespace), text nodes, and child order —
 * everything the patcher reconciles — and nothing else. Anything the code under
 * test calls that is not modelled here throws, loudly, rather than returning a
 * plausible empty value: a silent stub would let a regression pass.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

type FakeNode = FakeElement | FakeText;

/**
 * A CSS selector, to the extent the backend uses one.
 *
 * `interaction.ts` issues exactly three shapes — `svg`, `[data-mdv-region]` and
 * `[data-mdv-mark="id"]` — so those three are what is implemented. Anything else
 * throws: a selector engine that quietly matched nothing would turn a real
 * regression into a passing test.
 */
function matchesSelector(element: FakeElement, selector: string): boolean {
  const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr !== null) {
    const [, name, value] = attr;
    if (name === undefined) return false;
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    return value === undefined || actual === value;
  }
  if (/^[a-zA-Z]+$/.test(selector)) return element.localName === selector;
  throw new Error(`fake-dom: unsupported selector ${JSON.stringify(selector)}`);
}

/** A CSS style declaration, restricted to the property API the backend uses. */
export class FakeStyle {
  private readonly props = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }

  removeProperty(name: string): void {
    this.props.delete(name);
  }

  /** The declaration as a plain object, for assertions. */
  entries(): Record<string, string> {
    return Object.fromEntries([...this.props].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  get position(): string {
    return this.getPropertyValue('position');
  }
}

/** An event, carrying only the fields the interaction layer reads. */
export interface FakeEvent {
  readonly type: string;
  target?: FakeElement | null;
  readonly key?: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  defaultPrevented?: boolean;
  preventDefault?(): void;
}

type Listener = (event: FakeEvent) => void;

/** A text node. `nodeType` 3, as the patcher checks numerically. */
export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public nodeValue: string) {}
}

interface AttrRecord {
  readonly name: string;
  readonly ns: string | null;
  value: string;
}

/** An element. Attribute insertion order is preserved, as in a real DOM. */
export class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeNode[] = [];
  readonly style = new FakeStyle();
  private readonly attrs: AttrRecord[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  /** The box `getBoundingClientRect` reports. Settable, since nothing lays out. */
  box = { left: 0, top: 0, width: 0, height: 0 };
  /** `hidden` is a plain reflected property here; only its value is asserted. */
  hidden = false;

  constructor(
    readonly namespaceURI: string,
    readonly localName: string,
    readonly ownerDocument: FakeDocument | null = null,
  ) {}

  get className(): string {
    return this.getAttribute('class') ?? '';
  }

  set className(value: string) {
    this.setAttribute('class', value);
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  /** SVG elements are lower-case in both spellings; matching the real DOM. */
  get tagName(): string {
    return this.localName;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n.nodeType === 1);
  }

  /** Concatenated descendant text, as `Node.textContent` returns. */
  get textContent(): string {
    let out = '';
    for (const child of this.childNodes) {
      out += child.nodeType === 3 ? child.nodeValue : child.textContent;
    }
    return out;
  }

  /** Assigning replaces every child with one text node, as the real DOM does. */
  set textContent(value: string) {
    this.childNodes.length = 0;
    if (value.length > 0) this.appendChild(new FakeText(value));
  }

  /** Depth-first descendants, in document order. */
  private descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.childNodes) {
      if (child.nodeType !== 1) continue;
      out.push(child, ...child.descendants());
    }
    return out;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.descendants().find((e) => matchesSelector(e, selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((e) => matchesSelector(e, selector));
  }

  /** Self-or-ancestor match, which is how the pointer handler finds its region. */
  closest(selector: string): FakeElement | null {
    // `node` is a loop cursor that starts at this element and walks up, not an alias
    // captured by a closure; the rule exists to catch `const self = this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let node: FakeElement | null = this; node !== null; node = node.parentNode) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { ...this.box };
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list === undefined) this.listeners.set(type, [listener]);
    else list.push(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  }

  /** How many listeners are registered, so a disposer can be shown to work. */
  listenerCount(): number {
    let total = 0;
    for (const list of this.listeners.values()) total += list.length;
    return total;
  }

  /**
   * Dispatch bubbling from this node up through its ancestors, with `target`
   * pinned to the node the event started on — the interaction layer registers on
   * the `<svg>` but the pointer lands on a hit rect inside it, so without
   * bubbling the whole hover path would go untested.
   */
  dispatchEvent(event: FakeEvent): void {
    const e: FakeEvent = {
      ...event,
      target: this,
      defaultPrevented: false,
      preventDefault(): void {
        e.defaultPrevented = true;
      },
    };
    // `node` is a loop cursor that starts at this element and walks up, not an alias
    // captured by a closure; the rule exists to catch `const self = this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let node: FakeElement | null = this; node !== null; node = node.parentNode) {
      for (const listener of [...(node.listeners.get(event.type) ?? [])]) listener(e);
    }
    // Reported back on the caller's object, so a test can assert that the
    // handler claimed the key rather than letting it reach the page.
    event.defaultPrevented = e.defaultPrevented ?? false;
  }

  private find(name: string, ns: string | null): AttrRecord | undefined {
    return this.attrs.find((a) => a.name === name && a.ns === ns);
  }

  setAttribute(name: string, value: string): void {
    const existing = this.find(name, null);
    if (existing === undefined) this.attrs.push({ name, ns: null, value });
    else existing.value = value;
  }

  setAttributeNS(ns: string | null, qualified: string, value: string): void {
    // A real DOM stores the local name against the namespace; `xml:lang` is
    // therefore `getAttributeNS(XML_NS, 'lang')`.
    const local = qualified.includes(':') ? qualified.slice(qualified.indexOf(':') + 1) : qualified;
    const existing = this.find(local, ns);
    if (existing === undefined) this.attrs.push({ name: local, ns, value });
    else existing.value = value;
  }

  getAttribute(name: string): string | null {
    return this.find(name, null)?.value ?? null;
  }

  getAttributeNS(ns: string | null, local: string): string | null {
    return this.find(local, ns)?.value ?? null;
  }

  /** Qualified names, in insertion order — what `getAttributeNames` returns. */
  getAttributeNames(): string[] {
    return this.attrs.map((a) => (a.ns === XML_NS ? `xml:${a.name}` : a.name));
  }

  removeAttribute(name: string): void {
    const local = name.startsWith('xml:') ? name.slice(4) : name;
    const i = this.attrs.findIndex((a) => a.name === local || a.name === name);
    if (i >= 0) this.attrs.splice(i, 1);
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    const i = ref === null ? -1 : this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  replaceWith(next: FakeElement): void {
    const parent = this.parentNode;
    if (parent === null) return;
    const i = parent.childNodes.indexOf(this);
    next.parentNode?.removeChild(next);
    next.parentNode = parent;
    if (i >= 0) parent.childNodes.splice(i, 1, next);
    else parent.childNodes.push(next);
    this.parentNode = null;
  }

  /**
   * Serialise back to markup, so a DOM tree can be compared with a string.
   *
   * With `sortAttributes`, attributes are emitted in name order instead of
   * insertion order. That is for comparing two DOM trees with each other: the
   * patcher sets new attributes with `setAttribute`, which appends, so a
   * patched element carries the same attributes as a freshly built one in a
   * different order — true of a real DOM as well, and of no consequence, since
   * attribute order carries no meaning in SVG. Comparisons against the string
   * serialiser must *not* sort, because there the order is the guarantee.
   */
  toMarkup(options?: { readonly sortAttributes?: boolean }): string {
    const list = options?.sortAttributes === true ? [...this.attrs] : this.attrs;
    if (options?.sortAttributes === true) list.sort((a, b) => (a.name < b.name ? -1 : 1));
    const attrs = list
      .map((a) => {
        const name = a.ns === XML_NS ? `xml:${a.name}` : a.name;
        return ` ${name}="${escapeForCompare(a.value)}"`;
      })
      .join('');
    if (this.childNodes.length === 0 && !NEVER_SELF_CLOSE.has(this.localName)) {
      return `<${this.localName}${attrs}/>`;
    }
    let inner = '';
    for (const child of this.childNodes) {
      inner += child.nodeType === 3 ? escapeForCompare(child.nodeValue) : child.toMarkup(options);
    }
    return `<${this.localName}${attrs}>${inner}</${this.localName}>`;
  }
}

/**
 * The tags the string serialiser refuses to self-close, mirrored from
 * `src/string.ts`. The DOM has no such concept — an element is either empty or
 * not — so the mirror lives here, in the comparison serialiser, and the two
 * tests that diff a DOM tree against a golden string would fail loudly if the
 * backend's set ever changed.
 */
const NEVER_SELF_CLOSE = new Set([
  'svg',
  'g',
  'title',
  'desc',
  'defs',
  'text',
  'clipPath',
  'pattern',
]);

/** The same five entities the real serialiser escapes, for comparison only. */
function escapeForCompare(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The document factory `createElementTree` is handed. */
export class FakeDocument {
  /**
   * Every element this document made, so `getElementById` can find one without
   * a document tree to walk. A real document indexes connected elements only;
   * the difference does not arise here, where nothing is ever disconnected and
   * then looked up by id.
   */
  private readonly created: FakeElement[] = [];

  /** The focused element, which the pointer-leave handler consults. */
  activeElement: FakeElement | null = null;

  /** `null` unless a test supplies one, matching a detached document. */
  defaultView: { getComputedStyle(element: FakeElement): { position: string } } | null = null;

  createElementNS(ns: string, tag: string): FakeElement {
    const element = new FakeElement(ns, tag, this);
    this.created.push(element);
    return element;
  }

  createElement(tag: string): FakeElement {
    const element = new FakeElement('http://www.w3.org/1999/xhtml', tag, this);
    this.created.push(element);
    return element;
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement | null {
    return this.created.find((e) => e.getAttribute('id') === id) ?? null;
  }
}

/**
 * Make the fake elements pass `instanceof Element`.
 *
 * `interaction.ts` narrows an event target with `target instanceof Element`,
 * which is correct in a browser and a `ReferenceError` in Node, where there is
 * no such global. Pointing the global at the double is what a DOM environment
 * would do; without it the pointer path could not be tested at all.
 */
export function installElementGlobal(): void {
  const g = globalThis as { Element?: unknown };
  g.Element ??= FakeElement;
}

/** A document typed as the DOM `Document` the backend's signatures ask for. */
export function fakeDocument(): Document {
  return new FakeDocument() as unknown as Document;
}

/** A detached host element, as a `createSvgRenderer` target. */
export function fakeHost(doc: Document): Element {
  // An HTML container, as in the real embedding: the chart's own `<svg>` is a
  // child of it, which is the arrangement `findSvg` has to cope with.
  return (doc as unknown as FakeDocument).createElement('div') as unknown as Element;
}

export { SVG_NS, XML_NS };
