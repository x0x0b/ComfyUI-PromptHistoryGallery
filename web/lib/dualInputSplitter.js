import { clamp } from "./dom.js";
import { resolveComfyApp } from "./comfyBridge.js";

const DUAL_INPUT_NODE_TYPE = "PromptHistoryDualInput";
const DUAL_INPUT_NODE_TITLE = "Prompt History Dual Input";

const PROMPT_WIDGET_NAME = "prompt";
const NEGATIVE_WIDGET_NAME = "negative_prompt";
const RATIO_PROPERTY = "phg_prompt_widget_ratio";
const LEGACY_HEIGHT_PROPERTY = "phg_prompt_widget_height";
const MIN_WIDGET_HEIGHT = 40;
const NODE_WIDGET_HEIGHT = 20;
const WIDGET_GAP = 4;
const HANDLE_BAND = 12;
const RETRY_LIMIT = 60;
const RATIO_PRECISION = 10000;
const ATTACHED_FLAG = "__phg_dual_splitter__";
const RETRY_FLAG = "__phg_dual_splitter_retry__";
const HOVER_TOP_CLASS = "phg-splitter-band--top";
const HOVER_BOTTOM_CLASS = "phg-splitter-band--bottom";
const RESIZING_CLASS = "phg-splitter-resizing";

let dragState = null;

export function isDualInputNode(node) {
  if (!node) return false;
  const name = node.comfyClass ?? node.type;
  const matched = typeof name === "string" && name.endsWith(DUAL_INPUT_NODE_TYPE);
  return matched || node.title === DUAL_INPUT_NODE_TITLE;
}

function getScale() {
  const scale = resolveComfyApp()?.canvas?.ds?.scale;
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function findWidget(node, name) {
  if (!Array.isArray(node?.widgets)) return null;
  return node.widgets.find((widget) => widget?.name === name) ?? null;
}

function widgetStart(node) {
  let top = null;
  for (const widget of node?.widgets ?? []) {
    if (widget?.hidden || typeof widget?.y !== "number") continue;
    if (top === null || widget.y < top) top = widget.y;
  }
  return top;
}

function fixedWidgetHeight(node) {
  let total = 0;
  for (const widget of node?.widgets ?? []) {
    if (widget?.hidden || widget?.computeLayoutSize) continue;
    total +=
      typeof widget?.computedHeight === "number"
        ? widget.computedHeight
        : NODE_WIDGET_HEIGHT + WIDGET_GAP;
  }
  return total;
}

function flexibleSpace(node) {
  const body = node?.bodyHeight;
  const start = widgetStart(node);
  if (typeof body === "number" && body > 0 && start !== null) {
    const space = body - start - fixedWidgetHeight(node);
    if (space > 0) return space;
  }
  const free = node?.freeWidgetSpace;
  return typeof free === "number" && Number.isFinite(free) && free > 0 ? free : null;
}

function rawRatio(node) {
  const raw = node?.properties?.[RATIO_PROPERTY];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function ratioLimits(space) {
  if (!space || space <= 0) return { min: 0, max: 1 };
  const floor = Math.min(MIN_WIDGET_HEIGHT, space / 2) / space;
  return { min: floor, max: 1 - floor };
}

function resolveSplit(node) {
  const space = flexibleSpace(node);
  if (!space) return null;
  const stored = rawRatio(node) ?? migrateLegacyHeight(node, space);
  if (stored === null) return null;
  const limits = ratioLimits(space);
  const prompt = clamp(stored, limits.min, limits.max) * space;
  return { space, prompt: Math.max(0, prompt), negative: Math.max(0, space - prompt) };
}

function writeRatio(node, ratio) {
  if (!node.properties) node.properties = {};
  node.properties[RATIO_PROPERTY] = Math.round(ratio * RATIO_PRECISION) / RATIO_PRECISION;
  delete node.properties[LEGACY_HEIGHT_PROPERTY];
}

function migrateLegacyHeight(node, space) {
  const raw = node?.properties?.[LEGACY_HEIGHT_PROPERTY];
  const height = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(height) || !node?.properties) return null;
  const ratio = clamp(height / space, 0.05, 0.95);
  writeRatio(node, ratio);
  return ratio;
}

function syncHeightConstraint(node) {
  const prompt = findWidget(node, PROMPT_WIDGET_NAME);
  const negative = findWidget(node, NEGATIVE_WIDGET_NAME);
  if (!prompt || !negative) return;
  if (!prompt.options) prompt.options = {};
  if (!negative.options) negative.options = {};
  prompt.options.getMinHeight = () => MIN_WIDGET_HEIGHT;
  negative.options.getMinHeight = () => MIN_WIDGET_HEIGHT;
  prompt.options.getMaxHeight = () => resolveSplit(node)?.prompt;
  negative.options.getMaxHeight = () => resolveSplit(node)?.negative;
}

function relayout(node) {
  node.arrange?.();
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function bandAt(element, edge, clientY) {
  const rect = element.getBoundingClientRect();
  if (rect.height <= HANDLE_BAND * 2) return false;
  const offset = clientY - rect.top;
  return edge === "top" ? offset <= HANDLE_BAND : offset >= rect.height - HANDLE_BAND;
}

function setHover(element, className, active) {
  if (!element || element.classList.contains(className) === active) return;
  element.classList.toggle(className, active);
  element.style.cursor = active ? "ns-resize" : "";
}

function endDrag() {
  if (!dragState) return;
  const { node, element, className } = dragState;
  dragState = null;
  window.removeEventListener("pointermove", dragMove);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);
  document.body.classList.remove(RESIZING_CLASS);
  setHover(element, className, false);
  relayout(node);
}

function dragMove(event) {
  if (!dragState) return;
  event.preventDefault();
  const delta = (event.clientY - dragState.startY) / dragState.scale;
  const target = clamp(
    (dragState.startTop + delta) / dragState.space,
    dragState.min,
    dragState.max
  );
  const next = Math.round(target * RATIO_PRECISION) / RATIO_PRECISION;
  const node = dragState.node;
  if (rawRatio(node) === next) return;
  writeRatio(node, next);
  relayout(node);
}

function startDrag(node, element, className, event) {
  const split = resolveSplit(node);
  const space = split?.space ?? flexibleSpace(node);
  if (!space) return;
  const limits = ratioLimits(space);
  dragState = {
    node,
    element,
    className,
    startY: event.clientY,
    startTop: split ? split.prompt : space / 2,
    space,
    min: limits.min,
    max: limits.max,
    scale: getScale(),
  };
  event.preventDefault();
  event.stopPropagation();
  window.addEventListener("pointermove", dragMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  document.body.classList.add(RESIZING_CLASS);
  setHover(element, className, true);
}

function bindHandle(node, element, edge, className) {
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragState) return;
    if (!bandAt(element, edge, event.clientY)) return;
    startDrag(node, element, className, event);
  });
  element.addEventListener("pointermove", (event) => {
    if (dragState) return;
    setHover(element, className, bandAt(element, edge, event.clientY));
  });
  element.addEventListener("pointerleave", () => {
    if (!dragState) setHover(element, className, false);
  });
}

function tryAttach(node) {
  const promptEl = findWidget(node, PROMPT_WIDGET_NAME)?.element;
  const negativeEl = findWidget(node, NEGATIVE_WIDGET_NAME)?.element;
  if (!promptEl || !negativeEl) return false;
  syncHeightConstraint(node);
  bindHandle(node, negativeEl, "top", HOVER_TOP_CLASS);
  bindHandle(node, promptEl, "bottom", HOVER_BOTTOM_CLASS);
  return true;
}

function scheduleRetry(node) {
  if (node[RETRY_FLAG]) return;
  const previous = node.onDrawForeground;
  const state = { remaining: RETRY_LIMIT };
  const restore = () => {
    if (previous) node.onDrawForeground = previous;
    else delete node.onDrawForeground;
  };
  node[RETRY_FLAG] = state;
  node.onDrawForeground = function (context, ...rest) {
    const result = previous?.call(this, context, ...rest);
    if (!node[RETRY_FLAG]) return result;
    if (tryAttach(this)) {
      node[ATTACHED_FLAG] = true;
      delete node[RETRY_FLAG];
      restore();
    } else if (--state.remaining <= 0) {
      delete node[RETRY_FLAG];
      restore();
    }
    return result;
  };
}

export function attachDualInputSplitter(node) {
  if (!node || node[ATTACHED_FLAG] || !isDualInputNode(node)) return;
  if (tryAttach(node)) {
    node[ATTACHED_FLAG] = true;
    return;
  }
  scheduleRetry(node);
}
