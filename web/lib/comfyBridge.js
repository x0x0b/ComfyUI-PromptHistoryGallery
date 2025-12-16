import { LOG_PREFIX, logError } from "./dom.js";

function getLogger(logger) {
  return logger ?? console;
}

export function resolveComfyApp() {
  return window.comfyAPI?.app?.app ?? window.app ?? null;
}

export function resolveComfyApi() {
  const comfyApp = resolveComfyApp();
  return comfyApp?.api ?? window.comfyAPI?.api?.api ?? window.comfyAPI?.api ?? null;
}

export function resolvePromptWidget(node) {
  if (!node?.widgets || !Array.isArray(node.widgets)) return null;
  return node.widgets.find((widget) => widget?.name === "prompt") ?? null;
}

export function normalizeTargetPayload(node) {
  if (!node) return null;
  const widget = resolvePromptWidget(node);
  const nodeId = node.id ?? null;
  if (nodeId == null || !widget) return null;
  const nodeTitle =
    typeof node.getTitle === "function"
      ? node.getTitle()
      : node.title ?? node.comfyClass ?? "Prompt History Input";
  return {
    nodeId,
    graph: node.graph ?? null,
    nodeRef: node,
    widgetName: widget.name ?? "prompt",
    nodeTitle,
  };
}

export function resolveNodeFromTarget(target, logger = console) {
  if (!target) return null;
  const comfyApp = resolveComfyApp();
  const { nodeRef, nodeId, graph } = target;

  const resolveFromGraph = (graphInstance) => {
    if (!graphInstance?.getNodeById) return null;
    try {
      return graphInstance.getNodeById(nodeId) ?? null;
    } catch (error) {
      logError(getLogger(logger), "resolveNodeFromTarget getNodeById error", error);
      return null;
    }
  };

  let node = resolveFromGraph(graph);
  if (!node && nodeRef?.graph) {
    node = resolveFromGraph(nodeRef.graph);
  }
  if (!node && comfyApp?.graph) {
    node = resolveFromGraph(comfyApp.graph);
  }
  if (!node && Array.isArray(comfyApp?.graph?.nodes)) {
    node = comfyApp.graph.nodes.find((candidate) => candidate?.id === nodeId) ?? null;
  }
  if (!node && nodeRef) {
    node = nodeRef;
  }
  return node ?? null;
}

export function applyPromptToWidget(node, widget, promptText, comfyApp = resolveComfyApp()) {
  if (!node || !widget) return false;
  const normalized = typeof promptText === "string" ? promptText : String(promptText ?? "");
  const previous = typeof widget.value === "string" ? widget.value : widget.value ?? "";
  if (previous === normalized) {
    return false;
  }

  let handled = false;
  if (typeof widget.setValue === "function") {
    try {
      widget.setValue(normalized, {
        node,
        canvas: comfyApp?.canvas ?? null,
      });
      handled = true;
    } catch (error) {
      logError(getLogger(console), "applyPromptToWidget.setValue error", error);
    }
  }

  if (!handled) {
    try {
      widget.value = normalized;
      handled = true;
    } catch (error) {
      logError(getLogger(console), "applyPromptToWidget.value assignment error", error);
      return false;
    }
    if (typeof widget.callback === "function") {
      try {
        widget.callback(
          widget.value,
          comfyApp?.canvas ?? null,
          node,
          comfyApp?.canvas?.graph_mouse ?? null,
          null
        );
      } catch (error) {
        logError(getLogger(console), "applyPromptToWidget.callback error", error);
      }
    }
    if (typeof node.onWidgetChanged === "function") {
      try {
        node.onWidgetChanged(widget.name ?? "", widget.value, previous, widget);
      } catch (error) {
        logError(getLogger(console), "applyPromptToWidget.onWidgetChanged error", error);
      }
    }
  }

  if (Array.isArray(node.widgets_values)) {
    const index = node.widgets?.indexOf?.(widget) ?? -1;
    if (index !== -1) {
      node.widgets_values[index] = widget.value;
    }
  }

  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  if (node.graph) {
    node.graph._version = (node.graph._version ?? 0) + 1;
  }
  return true;
}
