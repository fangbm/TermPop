export interface OverlayLayer {
  container: Element;
  source: Element;
  zIndex: number;
}

export interface LayerPoint {
  x: number;
  y: number;
}

const MAX_CSS_Z_INDEX = 2_147_483_647;

export function resolveOverlayLayer(
  anchor: HTMLElement,
  overlayRoot: HTMLElement,
  point?: LayerPoint
): OverlayLayer {
  const source = resolveLayerSource(anchor, overlayRoot, point);
  const container = findTopLayerContainer(source) ?? document.documentElement;
  const contextLevels = collectStackingContextLevels(source, container);

  return {
    container,
    source,
    zIndex: overlayZIndexForContextLevels(contextLevels)
  };
}

// Context levels are ordered from the anchor towards the root. Only the
// outermost context competes with an overlay mounted at the root/container.
export function overlayZIndexForContextLevels(contextLevels: readonly number[]): number {
  const outermostLevel = contextLevels.length > 0 ? contextLevels[contextLevels.length - 1] : 0;
  return Math.min(MAX_CSS_Z_INDEX, Math.max(1, outermostLevel + 1));
}

function resolveLayerSource(anchor: HTMLElement, overlayRoot: HTMLElement, point?: LayerPoint): Element {
  if (anchor.dataset.termpopVirtualAnchor !== "true") {
    return anchor;
  }

  const rect = anchor.getBoundingClientRect();
  const x = clampToViewport(point?.x ?? rect.left + rect.width / 2, window.innerWidth);
  const y = clampToViewport(point?.y ?? rect.top + rect.height / 2, window.innerHeight);
  return document.elementsFromPoint(x, y).find((element) => (
    element !== anchor
    && element !== overlayRoot
    && !overlayRoot.contains(element)
  )) ?? anchor;
}

function collectStackingContextLevels(source: Element, stopAt: Element): number[] {
  const levels: number[] = [];
  let current: Element | null = source;

  while (current && current !== stopAt) {
    const style = getComputedStyle(current);
    if (createsStackingContext(current, style)) {
      levels.push(parseZIndex(style.zIndex));
    }
    current = composedParentElement(current);
  }

  return levels;
}

function createsStackingContext(element: Element, style: CSSStyleDeclaration): boolean {
  const position = style.position;
  const hasExplicitZIndex = style.zIndex !== "auto";
  const parentDisplay = composedParentElement(element)
    ? getComputedStyle(composedParentElement(element) as Element).display
    : "";
  const isFlexOrGridItem = /^(inline-)?(flex|grid)$/.test(parentDisplay);

  if (position === "fixed" || position === "sticky") {
    return true;
  }
  if (hasExplicitZIndex && (position !== "static" || isFlexOrGridItem)) {
    return true;
  }
  if (Number.parseFloat(style.opacity) < 1 || style.mixBlendMode !== "normal" || style.isolation === "isolate") {
    return true;
  }
  if (style.transform !== "none" || style.filter !== "none" || style.perspective !== "none") {
    return true;
  }
  if (cssPropertyIsActive(style, "translate") || cssPropertyIsActive(style, "rotate") || cssPropertyIsActive(style, "scale")) {
    return true;
  }
  if (cssPropertyIsActive(style, "backdrop-filter") || cssPropertyIsActive(style, "clip-path")) {
    return true;
  }
  if (cssPropertyIsActive(style, "mask") || cssPropertyIsActive(style, "mask-image")) {
    return true;
  }

  const contain = style.contain.toLocaleLowerCase().split(/\s+/);
  if (contain.some((value) => value === "layout" || value === "paint" || value === "strict" || value === "content")) {
    return true;
  }
  if (cssPropertyIsActive(style, "container-type", ["normal"])) {
    return true;
  }

  const willChange = style.willChange.toLocaleLowerCase().split(/\s*,\s*/);
  return willChange.some((value) => [
    "transform",
    "translate",
    "rotate",
    "scale",
    "opacity",
    "filter",
    "backdrop-filter",
    "perspective",
    "clip-path",
    "mask",
    "mix-blend-mode",
    "isolation"
  ].includes(value));
}

function findTopLayerContainer(source: Element): Element | undefined {
  let current: Element | null = source;
  while (current) {
    if (safeMatches(current, ":popover-open") || safeMatches(current, ":modal")) {
      return current;
    }
    current = composedParentElement(current);
  }

  const fullscreenElement = document.fullscreenElement;
  return fullscreenElement && isComposedDescendant(source, fullscreenElement)
    ? fullscreenElement
    : undefined;
}

function isComposedDescendant(source: Element, ancestor: Element): boolean {
  let current: Element | null = source;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = composedParentElement(current);
  }
  return false;
}

function composedParentElement(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function cssPropertyIsActive(
  style: CSSStyleDeclaration,
  property: string,
  inactiveValues: readonly string[] = ["none"]
): boolean {
  const value = style.getPropertyValue(property).trim().toLocaleLowerCase();
  return value !== "" && !inactiveValues.includes(value);
}

function parseZIndex(value: string): number {
  if (value === "auto") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function clampToViewport(value: number, size: number): number {
  return Math.min(Math.max(0, value), Math.max(0, size - 1));
}
