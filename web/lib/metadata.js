export function extractMetadata(entry) {
  if (!entry) return {};

  const params = {};

  let promptData = null;

  if (entry.metadata) {
    if (entry.metadata.comfyui_prompt) {
      promptData = entry.metadata.comfyui_prompt;
    } else if (entry.metadata.prompt) {
      try {
        promptData =
          typeof entry.metadata.prompt === "string"
            ? JSON.parse(entry.metadata.prompt)
            : entry.metadata.prompt;
      } catch (e) {}
    }

    let workflowData = null;
    if (entry.metadata.comfyui_workflow) {
      workflowData = entry.metadata.comfyui_workflow;
    } else if (entry.metadata.workflow) {
      try {
        workflowData =
          typeof entry.metadata.workflow === "string"
            ? JSON.parse(entry.metadata.workflow)
            : entry.metadata.workflow;
      } catch (e) {}
    }

    if (workflowData) {
      extractFromWorkflow(workflowData, params);
    }
  }

  if (promptData) {
    extractFromPrompt(promptData, params);
  }

  // Enforce metadata from backend (PNG source) if available
  if (entry.metadata) {
    const m = entry.metadata;
    if (m.seed !== undefined) params.seed = m.seed;
    if (m.steps !== undefined) params.steps = m.steps;
    if (m.cfg !== undefined) params.cfg = m.cfg;
    if (m.sampler) params.sampler = m.sampler;
    if (m.scheduler) params.scheduler = m.scheduler;
    if (m.model) params.model = m.model;
    if (m.width) params.width = m.width;
    if (m.height) params.height = m.height;
    if (m.denoise !== undefined) params.denoise = m.denoise;
  }

  return params;
}

function extractFromWorkflow(workflow, params) {
  if (!workflow || !workflow.nodes) return;

  for (const node of workflow.nodes) {
    const type = node.type;
    const widgets = node.widgets_values;

    if (!widgets) continue;

    if (["KSampler", "KSamplerAdvanced"].includes(type)) {
      if (widgets.length >= 4) {
        if (typeof widgets[0] === "number") params.seed = widgets[0];
        if (typeof widgets[1] === "number") params.steps = widgets[1];
        if (typeof widgets[2] === "number") params.cfg = widgets[2];
        if (typeof widgets[3] === "string") params.sampler = widgets[3];
        if (widgets.length > 4 && typeof widgets[4] === "string") params.scheduler = widgets[4];
      }
    } else if (
      type === "CheckpointLoader" ||
      type === "CheckpointLoaderSimple" ||
      type === "CheckpointLoader|pysssss"
    ) {
      if (widgets[0] && typeof widgets[0] === "string") params.model = widgets[0];
    } else if (type === "CheckpointLoader") {
      // CheckpointLoader has config_name at 0, ckpt_name at 1
      if (widgets[1] && typeof widgets[1] === "string") params.model = widgets[1];
    } else if (type === "EmptyLatentImage") {
      if (widgets.length >= 2) {
        if (typeof widgets[0] === "number") params.width = widgets[0];
        if (typeof widgets[1] === "number") params.height = widgets[1];
      }
    } else if (type === "CLIPTextEncode") {
      if (widgets[0] && typeof widgets[0] === "string") {
        const text = widgets[0];
        if (!params.prompt) {
          params.prompt = text;
        } else if (text !== params.prompt) {
          params.negative_prompt = text;
        }
      }
    }
  }
}

function extractFromPrompt(prompt, params) {
  if (!prompt) return;

  for (const key of Object.keys(prompt)) {
    const node = prompt[key];
    if (!node) continue;

    const classType = node.class_type;
    const inputs = node.inputs || {};

    if (
      classType === "CheckpointLoader" ||
      classType === "CheckpointLoaderSimple" ||
      classType === "CheckpointLoader|pysssss"
    ) {
      const model = inputs.ckpt_name || inputs.model_name;
      if (model && typeof model === "string") params.model = model;
    } else if (["KSampler", "KSamplerAdvanced"].includes(classType)) {
      if (typeof inputs.seed === "number" || typeof inputs.seed === "string")
        params.seed = inputs.seed;
      if (typeof inputs.steps === "number") params.steps = inputs.steps;
      if (typeof inputs.cfg === "number") params.cfg = inputs.cfg;
      if (typeof inputs.sampler_name === "string") params.sampler = inputs.sampler_name;
      if (typeof inputs.scheduler === "string") params.scheduler = inputs.scheduler;
      if (typeof inputs.denoise === "number" && inputs.denoise !== 1.0)
        params.denoise = inputs.denoise;
    } else if (classType === "EmptyLatentImage") {
      if (typeof inputs.width === "number") params.width = inputs.width;
      if (typeof inputs.height === "number") params.height = inputs.height;
      if (typeof inputs.batch_size === "number") params.batch_size = inputs.batch_size;
    } else if (classType === "CLIPTextEncode") {
      if (inputs.text && typeof inputs.text === "string") {
        const text = inputs.text;
        if (!params.prompt) {
          params.prompt = text;
        } else if (text !== params.prompt) {
          params.negative_prompt = text;
        }
      }
    }
  }
}

export function formatMetadata(params) {
  if (!params) return "";
  const parts = [];
  if (params.model) parts.push(params.model);
  if (params.width && params.height) parts.push(`${params.width}x${params.height}`);
  if (params.steps) parts.push(`Steps: ${params.steps}`);
  if (params.cfg) parts.push(`CFG: ${params.cfg}`);
  if (params.sampler) parts.push(params.sampler);
  if (params.scheduler) parts.push(params.scheduler);
  if (params.seed) parts.push(`Seed: ${params.seed}`);
  if (params.denoise) parts.push(`Denoise: ${params.denoise}`);
  return parts.join(" | ");
}
