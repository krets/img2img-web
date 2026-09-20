const BASE = "/api";

async function request(method, path, { json, form } = {}) {
  const opts = { method, headers: {} };
  if (json !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.body = form;
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail || detail;
    } catch (_) {}
    throw new Error(detail);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res;
}

export const api = {
  // Projects
  listProjects: (includeArchived = false) =>
    request("GET", `/projects?include_archived=${includeArchived}`),
  createProject: (name, description) =>
    request("POST", "/projects", { json: { name, description } }),
  updateProject: (id, body) => request("PUT", `/projects/${id}`, { json: body }),
  archiveProject: (id, archived = true) =>
    request("POST", `/projects/${id}/archive?archived=${archived}`),
  deleteProject: (id) => request("DELETE", `/projects/${id}`),
  restoreProject: (id) => request("POST", `/projects/${id}/restore`),
  permanentlyDeleteProject: (id) => request("DELETE", `/projects/${id}/permanent`),
  getTrashedProjects: () => request("GET", "/projects/trash"),
  getProjectTrash: (projectId) => request("GET", `/projects/${projectId}/trash`),

  // Images
  listImages: (projectId, { sort = "recent_result", filter = "all", search = "" } = {}) => {
    const params = new URLSearchParams({ sort, filter });
    if (search) params.set("search", search);
    return request("GET", `/projects/${projectId}/images?${params.toString()}`);
  },
  uploadImages: (projectId, files) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return request("POST", `/projects/${projectId}/images`, { form });
  },
  importImageFromUrl: (projectId, url) =>
    request("POST", `/projects/${projectId}/images/from-url`, { json: { url } }),
  importResult: (projectId, { imageId, sourceFile, displayName, resultFile, promptText, evaluation }) => {
    const form = new FormData();
    if (imageId) form.append("image_id", imageId);
    if (sourceFile) form.append("source_file", sourceFile);
    if (displayName) form.append("display_name", displayName);
    form.append("result_file", resultFile);
    form.append("prompt_text", promptText || "");
    form.append("evaluation", evaluation || "MAYBE");
    return request("POST", `/projects/${projectId}/results/import`, { form });
  },
  getImage: (id) => request("GET", `/images/${id}`),
  updateImage: (id, body) => request("PUT", `/images/${id}`, { json: body }),
  // Rotate/crop/pad settings applied to the source before it's sent to an engine;
  // both return the refreshed image detail. The stored source file is never modified.
  setImagePreprocess: (id, params) => request("PUT", `/images/${id}/preprocess`, { json: params }),
  clearImagePreprocess: (id) => request("DELETE", `/images/${id}/preprocess`),
  deleteImage: (id) => request("DELETE", `/images/${id}`),
  restoreImage: (id) => request("POST", `/images/${id}/restore`),
  permanentlyDeleteImage: (id) => request("DELETE", `/images/${id}/permanent`),
  getDuplicates: (projectId) => request("GET", `/projects/${projectId}/duplicates`),
  moveImages: (imageIds, targetProjectId) =>
    request("POST", "/images/move", { json: { image_ids: imageIds, target_project_id: targetProjectId } }),
  copyImages: (imageIds, targetProjectId) =>
    request("POST", "/images/copy", { json: { image_ids: imageIds, target_project_id: targetProjectId } }),
  mergeImages: (keepId, removeIds) =>
    request("POST", "/images/merge", { json: { keep_id: keepId, remove_ids: removeIds } }),

  // Reference images (per-project prep library, distinct from source images)
  listReferenceImages: (projectId) => request("GET", `/projects/${projectId}/reference-images`),
  uploadReferenceImage: (projectId, { file, displayName, cropBox }) => {
    const form = new FormData();
    form.append("file", file);
    if (displayName) form.append("display_name", displayName);
    if (cropBox) {
      form.append("crop_x", Math.round(cropBox.x));
      form.append("crop_y", Math.round(cropBox.y));
      form.append("crop_w", Math.round(cropBox.w));
      form.append("crop_h", Math.round(cropBox.h));
    }
    return request("POST", `/projects/${projectId}/reference-images`, { form });
  },
  updateReferenceImage: (refId, body) => request("PUT", `/reference-images/${refId}`, { json: body }),
  recropReferenceImage: (refId, cropBox) =>
    request("PUT", `/reference-images/${refId}/crop`, {
      json: { crop_x: Math.round(cropBox.x), crop_y: Math.round(cropBox.y), crop_w: Math.round(cropBox.w), crop_h: Math.round(cropBox.h) },
    }),
  deleteReferenceImage: (refId) => request("DELETE", `/reference-images/${refId}`),
  restoreReferenceImage: (refId) => request("POST", `/reference-images/${refId}/restore`),
  permanentlyDeleteReferenceImage: (refId) => request("DELETE", `/reference-images/${refId}/permanent`),

  // Prompts
  listPrompts: () => request("GET", "/prompts"),
  createPrompt: (title, prompt_text) =>
    request("POST", "/prompts", { json: { title, prompt_text } }),
  updatePrompt: (id, body) => request("PUT", `/prompts/${id}`, { json: body }),
  deletePrompt: (id) => request("DELETE", `/prompts/${id}`),

  // Results
  generateResult: (imageId, body) =>
    request("POST", `/images/${imageId}/generate`, { json: body }),
  setEvaluation: (resultId, evaluation) =>
    request("PUT", `/results/${resultId}/evaluation`, { json: { evaluation } }),
  activateResult: (resultId) => request("PUT", `/results/${resultId}/activate`),
  deleteResult: (resultId) => request("DELETE", `/results/${resultId}`),
  restoreResult: (resultId) => request("POST", `/results/${resultId}/restore`),
  permanentlyDeleteResult: (resultId) => request("DELETE", `/results/${resultId}/permanent`),
  trashNoResults: (projectId) => request("POST", `/projects/${projectId}/results/trash-no`),
  promoteResultToSource: (resultId) => request("POST", `/results/${resultId}/promote-to-source`),
  getQueue: () => request("GET", "/queue"),
  getQueueLog: () => request("GET", "/queue/log"),
  cancelJob: (jobId) => request("POST", `/queue/${jobId}/cancel`),

  // Config
  getConfig: () => request("GET", "/config"),
  updateConfig: (body) => request("PUT", "/config", { json: body }),
  checkConnection: () => request("POST", "/config/check-connection"),
  checkComfyuiConnection: () => request("POST", "/config/check-comfyui-connection"),
  comfyuiFree: () => request("POST", "/config/comfyui-free"),
  checkFalConnection: () => request("POST", "/config/check-fal-connection"),
  getFalModels: () => request("GET", "/config/fal-models"),

  // Export
  previewExport: (projectId, statusFilter) =>
    request("GET", `/projects/${projectId}/export/preview?status_filter=${statusFilter}`),
};
