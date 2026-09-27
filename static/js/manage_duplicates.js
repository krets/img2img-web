// Duplicates tab of the management page: near-duplicate clusters of sources
// and references across the selected projects (POST /api/manage/duplicates),
// with keep/ignore decisions and the safe cleanup actions.
//
// Merging only happens inside one project: sources through the existing
// /api/images/merge (which refuses cross-project), references by trashing the
// duplicates and pointing their uses at the kept one. Members in other
// projects are usually deliberate copies, so for them there are only
// decisions.

import { api } from "./api.js";
import { escapeHtml, plural, openImageLightbox, openConfirmModal } from "./ui.js";

const SETTINGS_KEY = "grok_img2img.manage.dupSettings";
const PAGE = 40; // clusters rendered per "Show more"
const DEFAULTS = { threshold: 8, kinds: ["source", "reference"], exclude_lineage: true, include_resolved: false };

function loadSettings() {
  try {
    const s = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
    s.threshold = Math.min(16, Math.max(0, Number(s.threshold) || 0));
    s.kinds = DEFAULTS.kinds.filter((k) => s.kinds.includes(k));
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

const view = {
  host: null,
  projectIds: [],
  settings: loadSettings(),
  clusters: [],
  meta: null,
  shown: PAGE,
  seq: 0,
  busy: false,
};

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(view.settings));
  } catch {
    // ignore
  }
}

const thumbUrl = (m) => (m.kind === "source" ? `/api/images/${m.id}/thumbnail` : `/api/reference-images/${m.id}/thumbnail`);
const fullUrl = (m) => (m.kind === "source" ? `/api/images/${m.id}/file` : `/api/reference-images/${m.id}/original`);

export function renderDuplicatesTab(host, projectIds) {
  view.host = host;
  view.projectIds = projectIds;
  const s = view.settings;
  host.innerHTML = `
    <div class="review-filters">
      <label class="review-filter-check dup-threshold" title="Largest perceptual-hash difference (of 64 bits) still counted as the same picture. Unrelated photos start around 16.">
        Similarity
        <input type="range" id="dupThreshold" min="0" max="16" step="2" value="${s.threshold}" />
        <span id="dupThresholdValue" class="dup-threshold-value"></span>
      </label>
      <label class="review-filter-check"><input type="checkbox" data-kind="source" ${s.kinds.includes("source") ? "checked" : ""} /> Sources</label>
      <label class="review-filter-check"><input type="checkbox" data-kind="reference" ${s.kinds.includes("reference") ? "checked" : ""} /> References</label>
      <label class="review-filter-check" title="Don't pair an image with the one it was promoted from: an edit resembles its parent on purpose">
        <input type="checkbox" id="dupLineage" ${s.exclude_lineage ? "checked" : ""} /> Skip parent/child
      </label>
      <label class="review-filter-check"><input type="checkbox" id="dupResolved" ${s.include_resolved ? "checked" : ""} /> Show resolved</label>
      <span id="dupCount" class="manage-hint review-count"></span>
    </div>
    <div id="dupList" class="dup-clusters"></div>
    <div class="review-more"><button id="dupMoreBtn" class="btn-ghost" type="button" style="display:none">Show more</button></div>
  `;
  const slider = host.querySelector("#dupThreshold");
  const showThreshold = () => {
    const v = Number(slider.value);
    host.querySelector("#dupThresholdValue").textContent = v === 0 ? "exact only" : `≤ ${v}`;
  };
  showThreshold();
  slider.addEventListener("input", showThreshold);
  slider.addEventListener("change", () => {
    s.threshold = Number(slider.value);
    settingsChanged();
  });
  host.querySelectorAll("[data-kind]").forEach((cb) =>
    cb.addEventListener("change", () => {
      s.kinds = DEFAULTS.kinds.filter((k) => host.querySelector(`[data-kind="${k}"]`).checked);
      settingsChanged();
    })
  );
  host.querySelector("#dupLineage").addEventListener("change", (e) => {
    s.exclude_lineage = e.target.checked;
    settingsChanged();
  });
  host.querySelector("#dupResolved").addEventListener("change", (e) => {
    s.include_resolved = e.target.checked;
    settingsChanged();
  });
  host.querySelector("#dupMoreBtn").addEventListener("click", () => {
    view.shown += PAGE;
    renderList();
  });
  view.root = host.querySelector("#dupList");
  host.querySelector("#dupList").addEventListener("click", onListClick);
  view.shown = PAGE;
  load();
}

function settingsChanged() {
  saveSettings();
  view.shown = PAGE;
  load();
}

// keepPlace: re-fetch after an action without jumping back to the top.
// True once a newer load has started or the tab has been swapped out of the
// shared panel (another tab rendered over it), so late responses are dropped.
function stale(seq) {
  return seq !== view.seq || !view.root?.isConnected;
}

async function load({ keepPlace = false } = {}) {
  const seq = ++view.seq;
  const count = view.host.querySelector("#dupCount");
  if (!view.projectIds.length || !view.settings.kinds.length) {
    view.clusters = [];
    view.meta = null;
    count.textContent = view.projectIds.length ? "Tick sources and/or references." : "No libraries selected.";
    renderList();
    return;
  }
  if (!keepPlace) count.textContent = "Looking for duplicates…";
  try {
    const out = await api.manage.duplicates({ ...view.settings, project_ids: view.projectIds });
    if (stale(seq)) return;
    view.clusters = out.clusters;
    view.meta = out;
  } catch (err) {
    if (stale(seq)) return;
    count.textContent = `Failed to load: ${err.message}`;
    return;
  }
  renderList();
}

function renderCount() {
  const m = view.meta;
  const count = view.host.querySelector("#dupCount");
  if (!m) return;
  const parts = [`${plural(view.clusters.length, "cluster")} in ${plural(m.total_items, "image")}`];
  if (m.resolved_hidden) parts.push(`${m.resolved_hidden} resolved hidden`);
  if (m.unhashed) parts.push(`${m.unhashed} not indexed yet`);
  count.textContent = parts.join(" · ");
}

// Suggested keeper when none is marked: the source with the most YES, then
// most rated, then most results (as the per-project duplicates dialog does);
// a reference by how many results used it; ties go to the anchor (earliest).
function suggestedKeep(c) {
  const score = (m) =>
    m.kind === "source"
      ? [1, m.result_counts.YES, m.result_counts.YES + m.result_counts.MAYBE + m.result_counts.NO, total(m)]
      : [0, 0, 0, m.used_in_results];
  let best = c.members[0];
  for (const m of c.members.slice(1)) {
    const a = score(m);
    const b = score(best);
    const i = a.findIndex((v, k) => v !== b[k]);
    if (i !== -1 && a[i] > b[i]) best = m;
  }
  return best;
}

const total = (m) => Object.values(m.result_counts).reduce((a, b) => a + b, 0);

function memberUsage(m) {
  if (m.kind === "reference") return `<span class="dup-usage">${m.used_in_results ? `used in ${plural(m.used_in_results, "result")}` : "unused"}</span>`;
  const n = total(m);
  if (!n) return `<span class="dup-usage">no results</span>`;
  const rc = m.result_counts;
  const seg = (cls, v) => (v ? `<span class="rating-seg ${cls}" style="flex:${v}" title="${cls}: ${v}"></span>` : "");
  return `<span class="dup-usage">${plural(n, "result")}<span class="rating-bar">${seg("YES", rc.YES)}${seg("MAYBE", rc.MAYBE)}${seg("NO", rc.NO)}${seg("UNRATED", rc.UNRATED)}</span></span>`;
}

// What the cluster's cleanup button would do, or null: fold the other live
// members of the kept one's kind and project into it.
function cleanupPlan(c) {
  const keep = c.members.find((m) => m.decision === "canonical");
  if (!keep) return null;
  const targets = c.members.filter(
    (m) => m !== keep && m.kind === keep.kind && m.project_id === keep.project_id && m.decision !== "ignore"
  );
  if (!targets.length) return null;
  return { keep, targets };
}

function clusterHtml(c, ci) {
  const projects = new Set(c.members.map((m) => m.project_id)).size;
  const hasKeep = c.members.some((m) => m.decision === "canonical");
  const suggested = hasKeep ? null : suggestedKeep(c);
  const plan = cleanupPlan(c);
  const planLabel = plan
    ? plan.keep.kind === "source"
      ? `Merge ${plan.targets.length} ${plan.targets.length === 1 ? "copy" : "copies"} into kept`
      : `Trash ${plural(plan.targets.length, "duplicate")}`
    : "";
  const similarity = c.max_distance === 0 ? "hash-identical" : `differ by ≤ ${c.max_distance}`;
  return `
    <section class="dup-cluster ${c.resolved ? "resolved" : ""}" data-ci="${ci}">
      <header class="dup-cluster-head">
        <span class="dup-cluster-title">${plural(c.members.length, "image")} · ${similarity}${projects > 1 ? ` · ${projects} libraries` : ""}</span>
        ${c.resolved ? `<span class="dup-badge resolved">Resolved</span>` : ""}
        <span class="dup-cluster-actions">
          ${plan ? `<button type="button" class="btn-ghost small danger-ish" data-act="cleanup" title="${plan.keep.kind === "source" ? "Combine their results onto the kept image and remove the copies (same library only)" : "Move the duplicate references to the trash; results that used them point at the kept one (same library only)"}">${planLabel}</button>` : ""}
          <button type="button" class="btn-ghost small" data-act="not-dup" title="Mark every image here as not a duplicate">Not duplicates</button>
          ${c.members.some((m) => m.decision) ? `<button type="button" class="btn-ghost small" data-act="clear-all" title="Clear the keep/ignore marks in this cluster">Reset</button>` : ""}
        </span>
      </header>
      <div class="dup-members">
        ${c.members.map((m, mi) => memberHtml(m, mi, m === suggested)).join("")}
      </div>
    </section>
  `;
}

function memberHtml(m, mi, suggested) {
  const decision =
    m.decision === "canonical"
      ? `<span class="dup-badge keep">★ Keep</span>`
      : m.decision === "ignore"
        ? `<span class="dup-badge ignore">Not a duplicate</span>`
        : suggested
          ? `<span class="dup-badge suggested" title="Most YES/rated results in this cluster">Suggested keep</span>`
          : "";
  const distance = m.distance_to_anchor === 0 ? "same" : m.distance_to_anchor == null ? "" : `Δ${m.distance_to_anchor}`;
  return `
    <div class="dup-member ${m.decision || ""}" data-mi="${mi}">
      <button type="button" class="dup-thumb" data-act="view" title="View full size">
        <img src="${thumbUrl(m)}" loading="lazy" alt="" />
        <span class="dup-kind ${m.kind}">${m.kind === "source" ? "SRC" : "REF"}</span>
      </button>
      <div class="dup-member-name" title="${escapeHtml(m.display_name)}">${escapeHtml(m.display_name)}</div>
      <div class="dup-member-meta" title="${escapeHtml(m.project_name)}">${escapeHtml(m.project_name)}</div>
      <div class="dup-member-meta">${m.width && m.height ? `${m.width}×${m.height}` : ""}${distance ? ` · ${distance}` : ""}</div>
      ${memberUsage(m)}
      ${decision}
      <div class="dup-member-actions">
        <button type="button" class="btn-ghost small ${m.decision === "canonical" ? "active" : ""}" data-act="keep" title="Keep this one">Keep</button>
        <button type="button" class="btn-ghost small ${m.decision === "ignore" ? "active" : ""}" data-act="ignore" title="Not a duplicate: leave it alone">Ignore</button>
      </div>
    </div>
  `;
}

function renderList() {
  const list = view.host.querySelector("#dupList");
  const shown = view.clusters.slice(0, view.shown);
  list.innerHTML = shown.length
    ? shown.map(clusterHtml).join("")
    : view.meta
      ? `<div class="empty-state">No duplicates at this similarity.</div>`
      : "";
  view.host.querySelector("#dupMoreBtn").style.display = view.clusters.length > view.shown ? "" : "none";
  renderCount();
}

async function onListClick(e) {
  const btn = e.target.closest("[data-act]");
  const section = e.target.closest("[data-ci]");
  if (!btn || !section || view.busy) return;
  const c = view.clusters[Number(section.dataset.ci)];
  const memberEl = btn.closest("[data-mi]");
  const m = memberEl ? c.members[Number(memberEl.dataset.mi)] : null;
  const act = btn.dataset.act;
  if (act === "view") return viewMember(c, c.members.indexOf(m));

  view.busy = true;
  try {
    if (act === "keep") {
      // Toggle; marking a new keeper unmarks the previous one.
      const items =
        m.decision === "canonical"
          ? [{ kind: m.kind, id: m.id, role: null }]
          : [
              { kind: m.kind, id: m.id, role: "canonical" },
              ...c.members.filter((o) => o !== m && o.decision === "canonical").map((o) => ({ kind: o.kind, id: o.id, role: null })),
            ];
      await api.manage.dupDecisions(items, c.anchor_id);
    } else if (act === "ignore") {
      await api.manage.dupDecisions([{ kind: m.kind, id: m.id, role: m.decision === "ignore" ? null : "ignore" }], c.anchor_id);
    } else if (act === "not-dup") {
      await api.manage.dupDecisions(c.members.map((o) => ({ kind: o.kind, id: o.id, role: "ignore" })), c.anchor_id);
    } else if (act === "clear-all") {
      await api.manage.dupDecisions(c.members.filter((o) => o.decision).map((o) => ({ kind: o.kind, id: o.id, role: null })), c.anchor_id);
    } else if (act === "cleanup") {
      await cleanup(c);
    }
    await load({ keepPlace: true });
  } catch (err) {
    view.host.querySelector("#dupCount").textContent = `Failed: ${err.message}`;
  } finally {
    view.busy = false;
  }
}

async function cleanup(c) {
  const plan = cleanupPlan(c);
  if (!plan) return;
  const names = plan.targets.map((t) => `“${t.display_name}”`).join(", ");
  const isSource = plan.keep.kind === "source";
  const ok = await openConfirmModal({
    title: isSource ? "Merge duplicates" : "Trash duplicate references",
    message: isSource
      ? `Merge ${names} into “${plan.keep.display_name}”? Their results move onto the kept image and the copies are deleted. This can't be undone.`
      : `Move ${names} to the trash? Results that used them will point at “${plan.keep.display_name}” instead.`,
    confirmLabel: isSource ? "Merge" : "Move to Trash",
    danger: true,
  });
  if (!ok) return;
  const ids = plan.targets.map((t) => t.id);
  if (isSource) await api.mergeImages(plan.keep.id, ids);
  else await api.manage.mergeReferences(plan.keep.id, ids);
}

function viewMember(c, idx) {
  const m = c.members[idx];
  openImageLightbox(fullUrl(m), m.display_name, {
    position: `${idx + 1} / ${c.members.length} · ${m.kind === "source" ? "Source" : "Reference"} · ${m.project_name} / ${m.display_name}`,
    onPrev: idx > 0 ? () => viewMember(c, idx - 1) : null,
    onNext: idx + 1 < c.members.length ? () => viewMember(c, idx + 1) : null,
  });
}
