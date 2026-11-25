// Warms the browser cache with the images the user is likely to step to next,
// so moving to the next image shows it at once instead of waiting a round trip
// plus the download. Relies on the image routes being cacheable (see
// http_cache.py); a prefetched URL that isn't cached would be wasted.
//
// Built for a slow, bandwidth-limited link: one download at a time, at low
// priority, and only once the viewer has finished loading what's on screen,
// so prefetching never competes with the image the user is actually looking
// at. Each call replaces the previous wish list, and an in-flight download
// that is no longer wanted is cancelled.

const VIEWER_BUSY_POLL_MS = 150;
const VIEWER_BUSY_MAX_WAIT_MS = 15000; // a full-res load that never settles mustn't block prefetching forever
const done = new Set(); // urls already fetched this page load
let queue = [];
let current = null; // { url, img }
let generation = 0;

// The A/B viewer marks each <img> with the full-res url it's upgrading to
// (viewer.js loadProgressive); until that's displayed, the viewer is busy.
function viewerBusy() {
  return [...document.querySelectorAll("img[data-pending-full]")].some(
    (img) => img.isConnected && img.getAttribute("src") !== img.dataset.pendingFull
  );
}

async function waitForViewer(gen) {
  const start = Date.now();
  while (viewerBusy() && Date.now() - start < VIEWER_BUSY_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, VIEWER_BUSY_POLL_MS));
    if (gen !== generation) return false;
  }
  return gen === generation;
}

async function pump(gen) {
  if (current || !queue.length) return;
  if (!(await waitForViewer(gen)) || current) return;
  const url = queue.shift();
  if (!url) return;
  const img = new Image();
  img.fetchPriority = "low";
  img.decoding = "async";
  current = { url, img };
  const finish = (ok) => {
    if (current?.img !== img) return;
    current = null;
    if (ok) done.add(url);
    pump(generation);
  };
  img.onload = () => finish(true);
  img.onerror = () => finish(false);
  img.src = url;
}

/** Replaces the prefetch wish list with `urls`, most wanted first. */
export function prefetchImages(urls) {
  generation += 1;
  queue = [...new Set(urls.filter((u) => u && !done.has(u)))];
  if (current && !queue.includes(current.url)) {
    current.img.src = ""; // abort a download nobody wants any more
    current = null;
  } else if (current) {
    queue = queue.filter((u) => u !== current.url);
  }
  pump(generation);
}
