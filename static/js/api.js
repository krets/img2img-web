const BASE = "/api";

// timeoutMs gives up on a request that hasn't answered in time, so a UI
// waiting on it (e.g. a button stuck on "Applying…") gets an error back
// instead of hanging forever on a stalled connection.
async function request(method, path, { json, form, timeoutMs } = {}) {
  const opts = { method, headers: {} };
  if (json !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.body = form;
  }
  if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(BASE + path, opts);
  } catch (e) {
    if (e.name === "TimeoutError") {
      throw new Error(`The server didn't answer within ${Math.round(timeoutMs / 1000)}s. Check the connection and try again.`);
    }
    throw e;
  }
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
  // Rotate/crop/pad settings applied to the source before it's sent to an engine.
  // Only the settings are sent; the server renders them (a few seconds at
  // most, even for a very large source). Both return the refreshed image
  // detail; the stored source file is never modified.
  setImagePreprocess: (id, params) => {
    const form = new FormData();
    form.append("params", JSON.stringify(params));
    return request("PUT", `/images/${id}/preprocess`, { form, timeoutMs: 60000 });
  },
  clearImagePreprocess: (id) => request("DELETE", `/images/${id}/preprocess`),
  // Lineage: parent is one of another image's results. Both return the refreshed image detail.
  setImageParent: (id, resultId) => request("PUT", `/images/${id}/parent`, { json: { result_id: resultId } }),
  clearImageParent: (id) => request("DELETE", `/images/${id}/parent`),
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
  // activeBlob is the already-cropped PNG (see app.js's cropImageToBlob) --
  // the server just stores it as the active file, no Pillow crop needed.
  uploadReferenceImage: (projectId, { file, displayName, cropBox, activeBlob }) => {
    const form = new FormData();
    form.append("file", file);
    if (displayName) form.append("display_name", displayName);
    if (cropBox) {
      form.append("crop_x", Math.round(cropBox.x));
      form.append("crop_y", Math.round(cropBox.y));
      form.append("crop_w", Math.round(cropBox.w));
      form.append("crop_h", Math.round(cropBox.h));
    }
    if (activeBlob) form.append("active_file", activeBlob, "active.png");
    return request("POST", `/projects/${projectId}/reference-images`, { form });
  },
  updateReferenceImage: (refId, body) => request("PUT", `/reference-images/${refId}`, { json: body }),
  recropReferenceImage: (refId, cropBox, activeBlob) => {
    const form = new FormData();
    form.append("crop_x", Math.round(cropBox.x));
    form.append("crop_y", Math.round(cropBox.y));
    form.append("crop_w", Math.round(cropBox.w));
    form.append("crop_h", Math.round(cropBox.h));
    form.append("active_file", activeBlob, "active.png");
    return request("PUT", `/reference-images/${refId}/crop`, { form });
  },
  deleteReferenceImage: (refId) => request("DELETE", `/reference-images/${refId}`),
  restoreReferenceImage: (refId) => request("POST", `/reference-images/${refId}/restore`),
  permanentlyDeleteReferenceImage: (refId) => request("DELETE", `/reference-images/${refId}/permanent`),

  // SAM3 interactive object-placement tool: detects an object (returned as a
  // transparent cutout for the frontend to drag/resize), then saves the
  // client-composited result as a reference image scoped to that one image.
  // Detection is queued like a generation (see jobs.py's kind="sam3_cutout")
  // rather than run inline, since ComfyUI only runs one prompt at a time and
  // this can end up waiting behind a real generation -- startSam3Cutout just
  // returns the queued job; poll getQueue() for it, then fetch the image at
  // `/queue/{job_id}/sam3-cutout` (a plain URL, not wrapped here) once done.
  // Multi-layer version: queues one job per prompt (bottom-to-top order,
  // capped at 5 server-side), all sharing a batch_id. getSam3CutoutBatch
  // polls for the raw cutouts as they finish.
  startSam3CutoutBatch: (imageId, sam3Prompts) =>
    request("POST", `/images/${imageId}/sam3-cutout-batch`, { json: { sam3_prompts: sam3Prompts } }),
  getSam3Layers: (imageId) => request("GET", `/images/${imageId}/sam3-layers`),
  setSam3Reference: (imageId, { file, sam3Prompt, sam3Prompts }) => {
    const form = new FormData();
    form.append("file", file);
    if (sam3Prompt) form.append("sam3_prompt", sam3Prompt);
    if (sam3Prompts) form.append("sam3_prompts", JSON.stringify(sam3Prompts));
    return request("POST", `/images/${imageId}/sam3-reference`, { form });
  },
  clearSam3Reference: (imageId) => request("DELETE", `/images/${imageId}/sam3-reference`),

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
  getComfyuiStats: () => request("GET", "/config/comfyui-stats"),
  checkFalConnection: () => request("POST", "/config/check-fal-connection"),
  getFalModels: () => request("GET", "/config/fal-models"),
  getBalances: () => request("GET", "/config/balances"),

  // Management (cross-library)
  manage: {
    summary: (includeArchived = false) =>
      request("GET", `/manage/summary?include_archived=${includeArchived}`),
    indexStatus: () => request("GET", "/manage/index/status"),
    prompts: (filter) => request("POST", "/manage/prompts", { json: filter }),
    engines: (filter) => request("POST", "/manage/engines", { json: filter }),
    duplicates: (body) => request("POST", "/manage/duplicates", { json: body }),
    listReports: () => request("GET", "/manage/reports"),
    getReport: (id) => request("GET", `/manage/reports/${id}`),
    createReport: (body) => request("POST", "/manage/reports", { json: body }),
    updateReport: (id, body) => request("PUT", `/manage/reports/${id}`, { json: body }),
    deleteReport: (id) => request("DELETE", `/manage/reports/${id}`),
    startExport: (body) => request("POST", "/manage/export", { json: body }),
    exportStatus: (jobId) => request("GET", `/manage/export/${jobId}`),
    dupDecisions: (items, clusterAnchorId = null) =>
      request("POST", "/manage/duplicates/decisions", { json: { items, cluster_anchor_id: clusterAnchorId } }),
    mergeReferences: (keepId, removeIds) =>
      request("POST", "/manage/duplicates/merge-references", { json: { keep_id: keepId, remove_ids: removeIds } }),
    revisedPrompts: (hash, filter) =>
      request("POST", `/manage/prompts/${encodeURIComponent(hash)}/revised`, { json: filter }),
    storage: (scope) => request("POST", "/manage/storage", { json: scope }),
    downscalePreview: (body) => request("POST", "/manage/storage/downscale/preview", { json: body }),
    startDownscale: (body) => request("POST", "/manage/storage/downscale", { json: body }),
    downscaleStatus: (jobId) => request("GET", `/manage/storage/downscale/${jobId}`),
    trashResults: (filter, ids = null) => request("POST", "/manage/results/trash", { json: { filter, ids } }),
    results: (filter, offset = 0, limit = 100) =>
      request("POST", `/manage/results?offset=${offset}&limit=${limit}`, { json: filter }),
  },
};
