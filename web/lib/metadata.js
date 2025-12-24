
export function extractMetadata(entry) {
  if (!entry) return {};
  
  const params = {};
  
  let promptData = null;
  
  if (entry.metadata) {
      if (entry.metadata.comfyui_prompt) {
          promptData = entry.metadata.comfyui_prompt;
      } else if (entry.metadata.prompt) {
           try {
               promptData = typeof entry.metadata.prompt === 'string' 
                   ? JSON.parse(entry.metadata.prompt) 
                   : entry.metadata.prompt;
           } catch (e) {}
      }
      
      let workflowData = null;
      if (entry.metadata.comfyui_workflow) {
          workflowData = entry.metadata.comfyui_workflow;
      } else if (entry.metadata.workflow) {
           try {
               workflowData = typeof entry.metadata.workflow === 'string' 
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
                if (typeof widgets[0] === 'number') params.seed = widgets[0];
                if (typeof widgets[1] === 'number') params.steps = widgets[1];
                if (typeof widgets[2] === 'number') params.cfg = widgets[2];
                if (typeof widgets[3] === 'string') params.sampler = widgets[3];
                if (widgets.length > 4 && typeof widgets[4] === 'string') params.scheduler = widgets[4];
            }
        } else if (type === "CheckpointLoaderSimple") {
            if (widgets[0] && typeof widgets[0] === 'string') params.model = widgets[0];
        } else if (type === "EmptyLatentImage") {
             if (widgets.length >= 2) {
                 if (typeof widgets[0] === 'number') params.width = widgets[0];
                 if (typeof widgets[1] === 'number') params.height = widgets[1];
             }
        } else if (type === "CLIPTextEncode") {
             if (widgets[0] && typeof widgets[0] === 'string') {
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

        if (classType === "CheckpointLoaderSimple") {
            if (inputs.ckpt_name) params.model = inputs.ckpt_name;
        } else if (["KSampler", "KSamplerAdvanced"].includes(classType)) {
            if (inputs.seed !== undefined) params.seed = inputs.seed;
            if (inputs.steps !== undefined) params.steps = inputs.steps;
            if (inputs.cfg !== undefined) params.cfg = inputs.cfg;
            if (inputs.sampler_name) params.sampler = inputs.sampler_name;
            if (inputs.scheduler) params.scheduler = inputs.scheduler;
            if (inputs.denoise !== undefined && inputs.denoise !== 1.0) params.denoise = inputs.denoise;
        } else if (classType === "EmptyLatentImage") {
            if (inputs.width) params.width = inputs.width;
            if (inputs.height) params.height = inputs.height;
            if (inputs.batch_size) params.batch_size = inputs.batch_size;
        } else if (classType === "CLIPTextEncode") {
            if (inputs.text && typeof inputs.text === 'string') {
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
