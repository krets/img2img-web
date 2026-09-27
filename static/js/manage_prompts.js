// Prompts tab of the management page: results across the selected projects
// grouped by prompt (POST /api/manage/prompts), as a sortable, searchable
// table. A row opens its results in the Review tab.

import { api } from "./api.js";
import { escapeHtml, formatRelativeTime, parseDbTime, openModal, closeModal, plural } from "./ui.js";

const SORT_KEY = "grok_img2img.manage.promptSort";
const NO_PROMPT = "(no prompt)";

// key -> [label, value(g), default direction]
const COLUMNS = {
  text: ["Prompt", (g) => (g.text || "").toLowerCase(), "asc"],
  n: ["Results", (g) => g.n, "desc"],
  unique_n: ["Unique", (g) => g.unique_n, "desc"],
  project_count: ["Libraries", (g) => g.project_count, "desc"],
  approval: ["Ratings", (g) => (g.n ? (g.yes + 0.5 * g.maybe) / g.n : 0), "desc"],
  last_used: ["Last used", (g) => g.last_used || "", "desc"],
};

function loadSort() {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY));
    if (s && COLUMNS[s.key] && (s.dir === "asc" || s.dir === "desc")) return s;
  } catch {
    // fall through
  }
  return { key: "n", dir: "desc" };
}

const view = {
  host: null,
  groups: [],
  projectNames: new Map(),
  sort: loadSort(),
  search: "",
  expanded: new Set(), // prompt hashes whose full text is shown
  seq: 0,
  onOpenInReview: null,
  projectIds: [],
};

// Mounts the tab. projectIds is never empty (see manage.js); projectNames maps
// id -> name for the Libraries column; onOpenInReview(hash, label) switches to
// the Review tab filtered to that prompt.
export function renderPromptsTab(host, projectIds, { projectNames, onOpenInReview }) {
  view.host = host;
  view.projectIds = projectIds;
  view.projectNames = projectNames;
  view.onOpenInReview = onOpenInReview;
  host.innerHTML = `
    <div class="review-filters">
      <input id="promptSearch" type="search" class="prompt-report-search" placeholder="Search prompts…" value="${escapeHtml(view.search)}" />
      <span id="promptCount" class="manage-hint review-count"></span>
    </div>
    <div class="prompt-report-wrap">
      <table class="prompt-report">
        <thead><tr id="promptHead"></tr></thead>
        <tbody id="promptBody"></tbody>
      </table>
    </div>
  `;
  host.querySelector("#promptSearch").addEventListener("input", (e) => {
    view.search = e.target.value;
    renderBody();
  });
  host.querySelector("#promptHead").addEventListener("click", (e) => {
    const th = e.target.closest("[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    view.sort = view.sort.key === key ? { key, dir: view.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: COLUMNS[key][2] };
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(view.sort));
    } catch {
      // ignore
    }
    renderHead();
    renderBody();
  });
  view.root = host.querySelector("#promptBody");
  host.querySelector("#promptBody").addEventListener("click", onBodyClick);
  renderHead();
  load();
}

// True once a newer load has started or the tab has been swapped out of the
// shared panel (another tab rendered over it), so late responses are dropped.
function stale(seq) {
  return seq !== view.seq || !view.root?.isConnected;
}

async function load() {
  const seq = ++view.seq;
  view.groups = [];
  const count = view.host.querySelector("#promptCount");
  if (!view.projectIds.length) {
    count.textContent = "No libraries selected.";
    renderBody();
    return;
  }
  count.textContent = "Loading…";
  try {
    const { groups } = await api.manage.prompts({ project_ids: view.projectIds });
    if (stale(seq)) return;
    view.groups = groups;
  } catch (err) {
    if (stale(seq)) return;
    count.textContent = `Failed to load: ${err.message}`;
    return;
  }
  renderBody();
}

function renderHead() {
  const { key, dir } = view.sort;
  view.host.querySelector("#promptHead").innerHTML =
    Object.entries(COLUMNS)
      .map(([k, [label]]) => {
        const arrow = k === key ? (dir === "asc" ? " ▲" : " ▼") : "";
        return `<th data-sort="${k}" class="sortable ${k === key ? "sorted" : ""}" aria-sort="${k === key ? (dir === "asc" ? "ascending" : "descending") : "none"}">${label}${arrow}</th>`;
      })
      .join("") + `<th></th>`;
}

function visibleGroups() {
  const q = view.search.trim().toLowerCase();
  const rows = q
    ? view.groups.filter((g) => (g.text || NO_PROMPT).toLowerCase().includes(q) || (g.palette_title || "").toLowerCase().includes(q))
    : [...view.groups];
  const [, value] = COLUMNS[view.sort.key];
  const sign = view.sort.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return b.n - a.n;
  });
  return rows;
}

function ratingBar(g) {
  const seg = (cls, v, label) => (v ? `<span class="rating-seg ${cls}" style="flex:${v}" title="${label}: ${v}"></span>` : "");
  return `<div class="rating-bar">${seg("YES", g.yes, "Yes")}${seg("MAYBE", g.maybe, "Maybe")}${seg("NO", g.no, "No")}${seg("UNRATED", g.unrated, "Unrated")}</div>`;
}

function rowHtml(g, idx) {
  const key = g.prompt_hash ?? "";
  const expanded = view.expanded.has(key);
  const libs = g.project_ids.map((id) => view.projectNames.get(id) || id).join(", ");
  const text = g.text ? escapeHtml(g.text) : `<span class="prompt-none">${NO_PROMPT}</span>`;
  const actions = g.text
    ? `<button type="button" class="btn-ghost small" data-act="copy" title="Copy prompt text">Copy</button>
       ${g.palette_title ? "" : `<button type="button" class="btn-ghost small" data-act="save" title="Save to the prompt palette">Save</button>`}
       ${g.revised_n ? `<button type="button" class="btn-ghost small" data-act="revised" title="Versions the engine rewrote this prompt into">Revised (${g.revised_n})</button>` : ""}`
    : "";
  return `
    <tr data-idx="${idx}" title="Show these results in Review">
      <td class="prompt-cell">
        ${g.palette_title ? `<span class="prompt-palette-chip" title="In the prompt palette">${escapeHtml(g.palette_title)}</span>` : ""}
        <div class="prompt-text ${expanded ? "expanded" : ""}">${text}</div>
        ${g.text && g.text.length > 140 ? `<button type="button" class="prompt-expand" data-act="expand">${expanded ? "Less" : "More"}</button>` : ""}
      </td>
      <td class="num">${g.n}</td>
      <td class="num">${g.unique_n}</td>
      <td class="num" title="${escapeHtml(libs)}">${g.project_count}</td>
      <td>${ratingBar(g)}</td>
      <td class="nowrap" title="${escapeHtml(g.last_used || "")} UTC">${formatRelativeTime(parseDbTime(g.last_used))}</td>
      <td class="prompt-actions">${actions}</td>
    </tr>
  `;
}

function renderBody() {
  const rows = visibleGroups();
  view.rows = rows;
  view.host.querySelector("#promptBody").innerHTML = rows.map(rowHtml).join("");
  const total = view.groups.length;
  const count = view.host.querySelector("#promptCount");
  if (!view.projectIds.length) return;
  const results = view.groups.reduce((a, g) => a + g.n, 0);
  count.textContent =
    rows.length === total ? `${plural(total, "prompt")} · ${plural(results, "result")}` : `${rows.length} of ${plural(total, "prompt")}`;
}

function onBodyClick(e) {
  const tr = e.target.closest("tr[data-idx]");
  if (!tr) return;
  const g = view.rows[Number(tr.dataset.idx)];
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "expand") {
    const key = g.prompt_hash ?? "";
    if (view.expanded.has(key)) view.expanded.delete(key);
    else view.expanded.add(key);
    renderBody();
  } else if (act === "copy") {
    copyPrompt(g, e.target);
  } else if (act === "save") {
    savePrompt(g);
  } else if (act === "revised") {
    showRevised(g);
  } else if (!window.getSelection()?.toString()) {
    // A plain click (not a text selection drag) opens the results.
    view.onOpenInReview?.(g.prompt_hash, g.palette_title || g.text || NO_PROMPT);
  }
}

// navigator.clipboard is missing over plain LAN HTTP (and refuses an unfocused
// page), so fall back to a selectable box like the main page's prompt copy.
async function copyPrompt(g, btn) {
  try {
    await navigator.clipboard.writeText(g.text);
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  } catch {
    const modal = openModal(`
      <h3>Prompt text</h3>
      <p class="modal-note">Clipboard access isn't available here — select all and copy manually.</p>
      <div class="field"><textarea id="mPromptText" class="prompt-edit-textarea" rows="8" readonly></textarea></div>
      <div class="modal-actions"><button id="mClose" class="btn-ghost" type="button">Close</button></div>
    `);
    const ta = modal.querySelector("#mPromptText");
    ta.value = g.text;
    modal.querySelector("#mClose").addEventListener("click", closeModal);
    ta.focus();
    ta.select();
  }
}

function savePrompt(g) {
  const modal = openModal(`
    <h3>Save to palette</h3>
    <div class="field"><label for="mTitle">Title</label><input id="mTitle" type="text" maxlength="120" /></div>
    <p class="modal-note">${escapeHtml(g.text.length > 300 ? g.text.slice(0, 300) + "…" : g.text)}</p>
    <div id="mStatus" class="status-line"></div>
    <div class="modal-actions">
      <button id="mCancel" class="btn-ghost" type="button">Cancel</button>
      <button id="mSave" class="btn-primary" type="button">Save</button>
    </div>
  `);
  const title = modal.querySelector("#mTitle");
  title.value = g.text.length > 60 ? g.text.slice(0, 60).replace(/\s+\S*$/, "") + "…" : g.text;
  title.focus();
  title.select();
  modal.querySelector("#mCancel").addEventListener("click", closeModal);
  const save = async () => {
    const t = title.value.trim();
    if (!t) return;
    try {
      await api.createPrompt(t, g.text);
      g.palette_title = t;
      closeModal();
      renderBody();
    } catch (err) {
      modal.querySelector("#mStatus").textContent = `Save failed: ${err.message}`;
    }
  };
  modal.querySelector("#mSave").addEventListener("click", save);
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
}

async function showRevised(g) {
  const modal = openModal(`<h3>Revised versions</h3><p class="modal-note" id="revisedLoading">Loading…</p>`);
  let rows;
  try {
    rows = await api.manage.revisedPrompts(g.prompt_hash, { project_ids: view.projectIds });
  } catch (err) {
    if (!modal.querySelector("#revisedLoading")) return; // closed (or replaced) while loading
    modal.innerHTML = `<h3>Revised versions</h3><p class="modal-note">Failed to load: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!modal.querySelector("#revisedLoading")) return;
  modal.innerHTML = `
    <h3>Revised versions</h3>
    <p class="modal-note">What the engine rewrote this prompt into, most common first.</p>
    <div class="revised-list">
      ${rows.map((r) => `<div class="revised-item"><span class="revised-n">×${r.n}</span><span>${escapeHtml(r.revised_prompt)}</span></div>`).join("")}
    </div>
    <div class="modal-actions"><button id="mClose" class="btn-ghost" type="button">Close</button></div>
  `;
  modal.querySelector("#mClose").addEventListener("click", closeModal);
}
