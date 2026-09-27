// Settings dialog (API keys, engines), opened from the topbar menu on both
// the Image Library and Review & Export.

import { api } from "./api.js";
import { escapeHtml, openModal, closeModal } from "./ui.js";

// Models fal_client.py has an explicit MODEL_SPECS entry for (correct
// image_url/image_urls shape + the right safety-filter fields for that
// model). Anything else -- picked via "Custom model ID..." below -- falls
// back to a best-guess shape server-side that may not be exactly right.
const FAL_MODELS = [
  { value: "fal-ai/flux-pro/kontext", label: "FLUX.1 Kontext [pro] — balanced quality (default)", group: "FLUX.1 Kontext" },
  { value: "fal-ai/flux-pro/kontext/max", label: "FLUX.1 Kontext [max] — best prompt adherence, pricier", group: "FLUX.1 Kontext" },
  { value: "fal-ai/flux-kontext/dev", label: "FLUX.1 Kontext [dev] — cheaper/faster, open-weight", group: "FLUX.1 Kontext" },
  { value: "fal-ai/flux-2/klein/4b/edit", label: "FLUX.2 [klein] 4B — fastest/cheapest FLUX.2 edit", group: "FLUX.2" },
  { value: "fal-ai/flux-2/klein/9b/edit", label: "FLUX.2 [klein] 9B — larger klein, better quality", group: "FLUX.2" },
  { value: "fal-ai/flux-2-pro/edit", label: "FLUX.2 [pro] — flagship editor, up to 9 reference images", group: "FLUX.2" },
  { value: "fal-ai/flux-2-flex/edit", label: "FLUX.2 [flex] — tunable quality/speed/cost, up to 10 references", group: "FLUX.2" },
];
const FAL_MODEL_CUSTOM = "__custom__";

// Populated on demand by the "Refresh from fal.ai" button in Settings (GET
// /api/config/fal-models). Kept in module scope, not persisted, so it
// survives closing/reopening the Settings modal within a session but a page
// reload starts back at just the curated FAL_MODELS list above.
let discoveredFalModels = [];

function isKnownFalModel(value) {
  return FAL_MODELS.some((m) => m.value === value) || discoveredFalModels.some((m) => m.value === value);
}

function renderFalModelOptions(selectedValue) {
  const groups = new Map();
  for (const m of FAL_MODELS) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const curatedValues = new Set(FAL_MODELS.map((m) => m.value));
  const discovered = discoveredFalModels.filter((m) => !curatedValues.has(m.value));
  if (discovered.length) groups.set("More from fal.ai", discovered);
  return [...groups.entries()]
    .map(
      ([group, models]) => `
        <optgroup label="${escapeHtml(group)}">
          ${models
            .map(
              (m) =>
                `<option value="${escapeHtml(m.value)}" ${selectedValue === m.value ? "selected" : ""}>${escapeHtml(m.label)}</option>`
            )
            .join("")}
        </optgroup>
      `
    )
    .join("");
}

function falModelSelectHtml(selectedValue) {
  return `
    ${renderFalModelOptions(selectedValue)}
    <option value="${FAL_MODEL_CUSTOM}" ${isKnownFalModel(selectedValue) ? "" : "selected"}>Custom model ID...</option>
  `;
}

export async function openSettingsModal() {
  const config = await api.getConfig();
  const modal = openModal(`
    <h3>Settings</h3>
    <div class="settings-section">
      <div class="settings-section-title">Grok (xAI)</div>
      <div class="field">
        <label>API Key</label>
        <div id="mKeyHint" class="field-hint">${config.has_api_key ? `Current: ${config.xai_api_key}` : ""}</div>
        <input id="mKey" type="password" placeholder="Enter to replace..." />
      </div>
      <div class="field"><label>Default Model</label><input id="mModel" type="text" value="${config.default_model}" /></div>
      <div class="field"><label>Default Max Dimension</label><input id="mMaxDim" type="number" value="${config.default_max_dim}" /></div>
      <div class="settings-section-actions">
        <button id="mCheck" class="btn-ghost small">Check Connection</button>
        <div id="mConnStatus" class="status-line"></div>
      </div>
      <div class="field">
        <label>Management Key <span class="hint">(optional; only needed to show the balance)</span></label>
        <div id="mXaiMgmtHint" class="field-hint">${config.has_xai_management_key ? `Current: ${config.xai_management_key}` : ""}</div>
        <input id="mXaiMgmtKey" type="password" placeholder="Enter to replace..." />
      </div>
      <div class="settings-section-actions">
        <button id="mCheckXaiBalance" class="btn-ghost small">Check Balance</button>
        <div id="mXaiBalanceStatus" class="status-line"></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Default Engine &amp; ComfyUI</div>
      <div class="field">
        <label>Default Engine</label>
        <select id="mEngine">
          <option value="grok" ${config.default_engine === "grok" ? "selected" : ""}>Grok</option>
          <option value="comfyui" ${config.default_engine === "comfyui" ? "selected" : ""}>ComfyUI (local)</option>
          <option value="fal" ${config.default_engine === "fal" ? "selected" : ""}>fal.ai</option>
        </select>
      </div>
      <div class="field"><label>ComfyUI URL</label><input id="mComfyUrl" type="text" value="${config.comfyui_url}" /></div>
      <div class="field"><label>ComfyUI Workflow File</label><input id="mComfyWorkflow" type="text" value="${config.comfyui_workflow_path}" /></div>
      <div class="settings-section-actions">
        <button id="mCheckComfy" class="btn-ghost small">Check Connection</button>
        <button id="mComfyFree" class="btn-warn small" title="Unload models and clear ComfyUI's execution cache">⏏ Unload Models</button>
      </div>
      <div id="mComfyConnStatus" class="status-line"></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">fal.ai</div>
      <div class="field">
        <label>API Key</label>
        <div id="mFalKeyHint" class="field-hint">${config.has_fal_api_key ? `Current: ${config.fal_api_key}` : ""}</div>
        <input id="mFalKey" type="password" placeholder="Enter to replace..." />
      </div>
      <div class="field">
        <label>Model</label>
        <div class="fal-model-row">
          <select id="mFalModel">
            ${falModelSelectHtml(config.fal_model)}
          </select>
          <button id="mFalModelRefresh" class="btn-ghost small" type="button">Refresh from fal.ai</button>
        </div>
        <input
          id="mFalModelCustom"
          type="text"
          placeholder="e.g. fal-ai/your-model-id"
          style="display:${isKnownFalModel(config.fal_model) ? "none" : "block"}; margin-top:6px;"
          value="${isKnownFalModel(config.fal_model) ? "" : escapeHtml(config.fal_model || "")}"
        />
        <div id="mFalModelsStatus" class="status-line"></div>
      </div>
      <div class="settings-section-actions">
        <button id="mCheckFal" class="btn-ghost small">Check Connection</button>
        <div id="mFalConnStatus" class="status-line"></div>
      </div>
      <div class="settings-section-actions">
        <button id="mCheckFalBalance" class="btn-ghost small" title="Showing the balance needs an ADMIN-scope API key">Check Balance</button>
        <div id="mFalBalanceStatus" class="status-line"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost">Close</button>
      <button id="mSave" class="btn-primary">Save</button>
    </div>
  `);
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  modal.querySelector("#mFalModel").addEventListener("change", (e) => {
    modal.querySelector("#mFalModelCustom").style.display = e.target.value === FAL_MODEL_CUSTOM ? "block" : "none";
  });
  modal.querySelector("#mFalModelRefresh").addEventListener("click", async () => {
    const select = modal.querySelector("#mFalModel");
    const statusEl = modal.querySelector("#mFalModelsStatus");
    const refreshBtn = modal.querySelector("#mFalModelRefresh");
    const previousValue = select.value === FAL_MODEL_CUSTOM ? modal.querySelector("#mFalModelCustom").value.trim() : select.value;
    refreshBtn.disabled = true;
    statusEl.textContent = "Fetching edit models from fal.ai...";
    try {
      const res = await api.getFalModels();
      discoveredFalModels = res.models;
      select.innerHTML = falModelSelectHtml(previousValue);
      modal.querySelector("#mFalModelCustom").style.display = isKnownFalModel(previousValue) ? "none" : "block";
      statusEl.textContent = `Found ${discoveredFalModels.length} edit model(s) from fal.ai.`;
    } catch (e) {
      statusEl.textContent = `Refresh failed: ${e.message}`;
    } finally {
      refreshBtn.disabled = false;
    }
  });
  modal.querySelector("#mCheck").addEventListener("click", async () => {
    modal.querySelector("#mConnStatus").textContent = "Checking...";
    const res = await api.checkConnection();
    modal.querySelector("#mConnStatus").textContent = res.message;
  });
  modal.querySelector("#mCheckComfy").addEventListener("click", async () => {
    modal.querySelector("#mComfyConnStatus").textContent = "Checking...";
    const res = await api.checkComfyuiConnection();
    modal.querySelector("#mComfyConnStatus").textContent = res.message;
  });
  modal.querySelector("#mComfyFree").addEventListener("click", async () => {
    modal.querySelector("#mComfyConnStatus").textContent = "Unloading models and freeing cache...";
    const res = await api.comfyuiFree();
    modal.querySelector("#mComfyConnStatus").textContent = res.message;
  });
  modal.querySelector("#mCheckFal").addEventListener("click", async () => {
    modal.querySelector("#mFalConnStatus").textContent = "Checking...";
    const res = await api.checkFalConnection();
    modal.querySelector("#mFalConnStatus").textContent = res.message;
  });
  const balanceEls = {
    grok: modal.querySelector("#mXaiBalanceStatus"),
    fal: modal.querySelector("#mFalBalanceStatus"),
  };
  const showBalance = (provider, res) => {
    balanceEls[provider].textContent = res.ok ? `Balance: $${res.balance.toFixed(2)}` : res.message;
  };
  // Persists any keys typed into the modal first, so a key entered just now is
  // used without having to Save and reopen Settings.
  const checkBalance = async (provider) => {
    balanceEls[provider].textContent = "Checking...";
    try {
      const updated = await api.updateConfig({
        xai_api_key: modal.querySelector("#mKey").value || undefined,
        xai_management_key: modal.querySelector("#mXaiMgmtKey").value || undefined,
        fal_api_key: modal.querySelector("#mFalKey").value || undefined,
      });
      for (const [inputId, hintId, has, masked] of [
        ["#mKey", "#mKeyHint", updated.has_api_key, updated.xai_api_key],
        ["#mXaiMgmtKey", "#mXaiMgmtHint", updated.has_xai_management_key, updated.xai_management_key],
        ["#mFalKey", "#mFalKeyHint", updated.has_fal_api_key, updated.fal_api_key],
      ]) {
        modal.querySelector(inputId).value = "";
        modal.querySelector(hintId).textContent = has ? `Current: ${masked}` : "";
      }
      showBalance(provider, (await api.getBalances())[provider]);
    } catch (e) {
      balanceEls[provider].textContent = `Balance check failed: ${e.message}`;
    }
  };
  modal.querySelector("#mCheckXaiBalance").addEventListener("click", () => checkBalance("grok"));
  modal.querySelector("#mCheckFalBalance").addEventListener("click", () => checkBalance("fal"));
  const grokBalanceConfigured = config.has_api_key && config.has_xai_management_key;
  if (grokBalanceConfigured || config.has_fal_api_key) {
    if (grokBalanceConfigured) balanceEls.grok.textContent = "Loading balance...";
    if (config.has_fal_api_key) balanceEls.fal.textContent = "Loading balance...";
    api
      .getBalances()
      .then((res) => {
        if (grokBalanceConfigured) showBalance("grok", res.grok);
        if (config.has_fal_api_key) showBalance("fal", res.fal);
      })
      .catch((e) => {
        for (const el of Object.values(balanceEls)) if (el.textContent === "Loading balance...") el.textContent = `Balance unavailable: ${e.message}`;
      });
  }
  modal.querySelector("#mSave").addEventListener("click", async () => {
    const falModelSelected = modal.querySelector("#mFalModel").value;
    const falModel =
      falModelSelected === FAL_MODEL_CUSTOM
        ? modal.querySelector("#mFalModelCustom").value.trim()
        : falModelSelected;
    await api.updateConfig({
      xai_api_key: modal.querySelector("#mKey").value || undefined,
      default_model: modal.querySelector("#mModel").value,
      default_max_dim: parseInt(modal.querySelector("#mMaxDim").value, 10),
      default_engine: modal.querySelector("#mEngine").value,
      comfyui_url: modal.querySelector("#mComfyUrl").value,
      comfyui_workflow_path: modal.querySelector("#mComfyWorkflow").value,
      fal_api_key: modal.querySelector("#mFalKey").value || undefined,
      fal_model: falModel,
      xai_management_key: modal.querySelector("#mXaiMgmtKey").value || undefined,
    });
    closeModal();
  });
}
