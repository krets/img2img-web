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
  deleteImage: (id) => request("DELETE", `/images/${id}`),
  restoreImage: (id) => request("POST", `/images/${id}/restore`),
  permanentlyDeleteImage: (id) => request("DELETE", `/images/${id}/permanent`),
  getDuplicates: (projectId) => request("GET", `/projects/${projectId}/duplicates`),
  moveImages: (imageIds, targetProjectId) =>
    request("POST", "/images/move", { json: { image_ids: imageIds, target_project_id: targetProjectId } }),
  mergeImages: (keepId, removeIds) =>
    request("POST", "/images/merge", { json: { keep_id: keepId, remove_ids: removeIds } }),

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
  getQueue: () => request("GET", "/queue"),

  // Config
  getConfig: () => request("GET", "/config"),
  updateConfig: (body) => request("PUT", "/config", { json: body }),
  checkConnection: () => request("POST", "/config/check-connection"),
  checkComfyuiConnection: () => request("POST", "/config/check-comfyui-connection"),
};
