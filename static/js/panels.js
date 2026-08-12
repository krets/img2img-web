/** Resizable/collapsible side panels + a maximize-viewport toggle.
 * Drag handles resize #sidebar/#detailsPanel via CSS custom properties on
 * #layout; collapse buttons zero a panel's width and reveal an expand tab;
 * maximize collapses both at once. All state persists to localStorage.
 */
const STORAGE_KEY = "grok_img2img.panelLayout";

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 300;
const DETAILS_MIN = 260;
const DETAILS_MAX = 560;
const DETAILS_DEFAULT = 340;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

export function initPanels() {
  const layout = document.getElementById("layout");
  const sidebar = document.getElementById("sidebar");
  const details = document.getElementById("detailsPanel");
  const sidebarHandle = document.getElementById("sidebarResizeHandle");
  const detailsHandle = document.getElementById("detailsResizeHandle");
  const sidebarCollapseBtn = document.getElementById("sidebarCollapseBtn");
  const detailsCollapseBtn = document.getElementById("detailsCollapseBtn");
  const sidebarExpandTab = document.getElementById("sidebarExpandTab");
  const detailsExpandTab = document.getElementById("detailsExpandTab");
  const maximizeBtn = document.getElementById("maximizeViewportBtn");

  const s = {
    sidebarWidth: SIDEBAR_DEFAULT,
    detailsWidth: DETAILS_DEFAULT,
    sidebarCollapsed: false,
    detailsCollapsed: false,
    maximized: false,
    ...loadState(),
  };

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }

  function apply() {
    const sidebarHidden = s.maximized || s.sidebarCollapsed;
    const detailsHidden = s.maximized || s.detailsCollapsed;
    layout.style.setProperty("--sidebar-w", sidebarHidden ? "0px" : `${s.sidebarWidth}px`);
    layout.style.setProperty("--details-w", detailsHidden ? "0px" : `${s.detailsWidth}px`);
    sidebar.classList.toggle("collapsed", sidebarHidden);
    details.classList.toggle("collapsed", detailsHidden);
    sidebarExpandTab.style.display = !s.maximized && s.sidebarCollapsed ? "flex" : "none";
    detailsExpandTab.style.display = !s.maximized && s.detailsCollapsed ? "flex" : "none";
    maximizeBtn.classList.toggle("active", s.maximized);
  }

  function makeDrag(handle, { getWidth, setWidth, min, max, fromRight }) {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = getWidth();
      handle.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const delta = fromRight ? startX - e.clientX : e.clientX - startX;
      setWidth(Math.min(max, Math.max(min, startWidth + delta)));
      apply();
    });
    function stop() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      persist();
    }
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  makeDrag(sidebarHandle, {
    getWidth: () => s.sidebarWidth,
    setWidth: (w) => (s.sidebarWidth = w),
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    fromRight: false,
  });
  makeDrag(detailsHandle, {
    getWidth: () => s.detailsWidth,
    setWidth: (w) => (s.detailsWidth = w),
    min: DETAILS_MIN,
    max: DETAILS_MAX,
    fromRight: true,
  });

  sidebarCollapseBtn.addEventListener("click", () => {
    s.sidebarCollapsed = true;
    apply();
    persist();
  });
  sidebarExpandTab.addEventListener("click", () => {
    s.sidebarCollapsed = false;
    apply();
    persist();
  });
  detailsCollapseBtn.addEventListener("click", () => {
    s.detailsCollapsed = true;
    apply();
    persist();
  });
  detailsExpandTab.addEventListener("click", () => {
    s.detailsCollapsed = false;
    apply();
    persist();
  });

  function toggleMaximize() {
    s.maximized = !s.maximized;
    apply();
    persist();
  }
  maximizeBtn.addEventListener("click", toggleMaximize);

  document.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    if (e.key.toLowerCase() !== "f") return;
    toggleMaximize();
  });

  apply();

  return { toggleMaximize };
}
