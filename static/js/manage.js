// Cross-library management page (/manage). Separate from app.js on purpose:
// the generation page is built around one current project, while everything
// here works over a set of them. Both pages share the database, so there is no
// in-memory state to keep in sync.

import { api } from "./api.js";
import { escapeHtml, plural } from "./ui.js";
import { renderReviewTab, setReviewPrompt } from "./manage_review.js";
import { renderPromptsTab } from "./manage_prompts.js";
import { renderDuplicatesTab } from "./manage_duplicates.js";

const SELECTION_KEY = "grok_img2img.manage.projectIds";
const TAB_KEY = "grok_img2img.manage.tab";
const ARCHIVED_KEY = "grok_img2img.manage.showArchived";
const TABS = ["prompts", "duplicates", "review", "reports"];
const INDEX_POLL_MS = 5000;

function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full/unavailable -- the selection just won't persist
  }
}

const state = {
  projects: [], // every live project, archived included
  counts: new Map(), // project id -> { source, reference, result } live counts
  // Explicitly ticked projects. Empty means "no constraint", i.e. all shown
  // libraries, matching ManageFilterIn's empty-list semantics.
  selectedIds: new Set(loadJson(SELECTION_KEY, [])),
  showArchived: loadJson(ARCHIVED_KEY, false) === true,
  tab: TABS.includes(localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : TABS[0],
};

const els = {
  projectList: document.getElementById("projectList"),
  selectionHint: document.getElementById("selectionHint"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectNoneBtn: document.getElementById("selectNoneBtn"),
  showArchivedInput: document.getElementById("showArchivedInput"),
  tabButtons: [...document.querySelectorAll("[data-manage-tab]")],
  tabPanel: document.getElementById("tabPanel"),
  indexStatus: document.getElementById("indexStatus"),
};

function visibleProjects() {
  return state.showArchived ? state.projects : state.projects.filter((p) => !p.is_archived);
}

// Project ids the tabs should query: the ticked ones, or every visible
// project when nothing is ticked.
function effectiveProjectIds() {
  const visible = visibleProjects().map((p) => p.id);
  if (!state.selectedIds.size) return visible;
  return visible.filter((id) => state.selectedIds.has(id));
}

function persistSelection() {
  saveJson(SELECTION_KEY, [...state.selectedIds]);
}

// ---------------------------------------------------------------------------
// Project multi-select
// ---------------------------------------------------------------------------

function renderProjectList() {
  const projects = visibleProjects();
  if (!projects.length) {
    els.projectList.innerHTML = `<div class="empty-state">No libraries yet.</div>`;
  } else {
    els.projectList.innerHTML = projects
      .map((p) => {
        const c = state.counts.get(p.id);
        const counts = c ? `${c.source} src · ${c.result} res` : "";
        return `
          <label class="manage-project-row ${p.is_archived ? "archived" : ""}" title="${escapeHtml(p.name)}">
            <input type="checkbox" data-project-id="${p.id}" ${state.selectedIds.has(p.id) ? "checked" : ""} />
            <span class="manage-project-name">${escapeHtml(p.name)}</span>
            <span class="manage-project-counts">${counts}</span>
          </label>
        `;
      })
      .join("");
  }
  renderSelectionHint();
}

function renderSelectionHint() {
  const n = effectiveProjectIds().length;
  const libraries = `${n} ${n === 1 ? "library" : "libraries"}`;
  els.selectionHint.textContent = state.selectedIds.size ? `${libraries} selected` : `None ticked: all ${libraries}`;
}

els.projectList.addEventListener("change", (e) => {
  const id = e.target.dataset.projectId;
  if (!id) return;
  if (e.target.checked) state.selectedIds.add(id);
  else state.selectedIds.delete(id);
  persistSelection();
  renderSelectionHint();
  renderTab();
});

els.selectAllBtn.addEventListener("click", () => {
  state.selectedIds = new Set(visibleProjects().map((p) => p.id));
  persistSelection();
  renderProjectList();
  renderTab();
});
els.selectNoneBtn.addEventListener("click", () => {
  state.selectedIds.clear();
  persistSelection();
  renderProjectList();
  renderTab();
});

els.showArchivedInput.checked = state.showArchived;
els.showArchivedInput.addEventListener("change", () => {
  state.showArchived = els.showArchivedInput.checked;
  saveJson(ARCHIVED_KEY, state.showArchived);
  renderProjectList();
  renderTab();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TAB_PLACEHOLDERS = {
  reports: "Saved report definitions and export.",
};

function selectionTotals() {
  const totals = { source: 0, reference: 0, result: 0 };
  for (const id of effectiveProjectIds()) {
    const c = state.counts.get(id);
    if (!c) continue;
    for (const k in totals) totals[k] += c[k];
  }
  return totals;
}

function renderTab() {
  els.tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.manageTab === state.tab));
  if (state.tab === "review") {
    renderReviewTab(els.tabPanel, effectiveProjectIds());
    return;
  }
  if (state.tab === "duplicates") {
    renderDuplicatesTab(els.tabPanel, effectiveProjectIds());
    return;
  }
  if (state.tab === "prompts") {
    renderPromptsTab(els.tabPanel, effectiveProjectIds(), {
      projectNames: new Map(state.projects.map((p) => [p.id, p.name])),
      onOpenInReview: (hash, label) => {
        setReviewPrompt(hash, label);
        selectTab("review");
      },
    });
    return;
  }
  const t = selectionTotals();
  els.tabPanel.innerHTML = `
    <p class="manage-hint">${plural(t.source, "source")} · ${plural(t.reference, "reference")} · ${plural(t.result, "result")}</p>
    <div class="empty-state">${escapeHtml(TAB_PLACEHOLDERS[state.tab])} Not built yet.</div>
  `;
}

function selectTab(tab) {
  state.tab = tab;
  try {
    localStorage.setItem(TAB_KEY, state.tab);
  } catch {
    // ignore
  }
  renderTab();
}

els.tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => selectTab(btn.dataset.manageTab));
});

// ---------------------------------------------------------------------------
// Hash index status (background worker from hash_worker.py)
// ---------------------------------------------------------------------------

async function pollIndexStatus() {
  try {
    const s = await api.manage.indexStatus();
    const pending = Object.values(s.pending || {}).reduce((a, b) => a + b, 0);
    els.indexStatus.textContent = s.running || pending ? `Indexing… ${pending} pending` : "Index up to date";
    els.indexStatus.classList.toggle("busy", !!(s.running || pending));
    if (s.running || pending) setTimeout(pollIndexStatus, INDEX_POLL_MS);
  } catch {
    els.indexStatus.textContent = "";
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  const [projects, summary] = await Promise.all([api.listProjects(true), api.manage.summary(true)]);
  state.projects = projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  state.counts = new Map(summary.projects.map((p) => [p.project_id, p]));
  // Drop remembered ids for projects that have since been deleted.
  const live = new Set(state.projects.map((p) => p.id));
  const before = state.selectedIds.size;
  state.selectedIds = new Set([...state.selectedIds].filter((id) => live.has(id)));
  if (state.selectedIds.size !== before) persistSelection();
  renderProjectList();
  renderTab();
  pollIndexStatus();
})();
