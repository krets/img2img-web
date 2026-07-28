/** Self-contained A/B comparison slider: source image left, result image right,
 * revealed by a draggable vertical handle using a CSS clip-path.
 */
export function initABViewer(container) {
  container.innerHTML = `
    <div class="ab-stage" id="abStage">
      <img class="ab-base" id="abBase" alt="Source" />
      <div class="ab-overlay" id="abOverlay">
        <img class="ab-result" id="abResult" alt="Result" />
      </div>
      <div class="ab-handle" id="abHandle"><div class="ab-handle-grip"></div></div>
      <div class="ab-actions" id="abActions">
        <button class="ab-action-btn" id="abCopyBtn" title="Copy result image to clipboard">📋 Copy</button>
        <button class="ab-action-btn" id="abOpenBtn" title="Open result image in a new tab">↗ Open</button>
      </div>
    </div>
    <div class="ab-empty" id="abEmpty">Select an image to begin.</div>
  `;

  const stage = container.querySelector("#abStage");
  const base = container.querySelector("#abBase");
  const resultImg = container.querySelector("#abResult");
  const overlay = container.querySelector("#abOverlay");
  const handle = container.querySelector("#abHandle");
  const empty = container.querySelector("#abEmpty");
  const actions = container.querySelector("#abActions");
  const copyBtn = container.querySelector("#abCopyBtn");
  const openBtn = container.querySelector("#abOpenBtn");

  let currentResultUrl = null;

  // Re-encodes as PNG via canvas since the Clipboard API only reliably
  // accepts image/png across browsers, regardless of the source file's format.
  async function copyImageToClipboard(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  }

  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentResultUrl) return;
    const original = copyBtn.textContent;
    try {
      await copyImageToClipboard(currentResultUrl);
      copyBtn.textContent = "✓ Copied";
    } catch (err) {
      copyBtn.textContent = "✕ Failed";
    } finally {
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1200);
    }
  });

  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!currentResultUrl) return;
    window.open(currentResultUrl, "_blank", "noopener");
  });

  let percent = 50;
  let dragging = false;

  function applyPercent(p) {
    percent = Math.min(100, Math.max(0, p));
    overlay.style.clipPath = `inset(0 0 0 ${percent}%)`;
    handle.style.left = `${percent}%`;
  }

  function percentFromEvent(evt) {
    const rect = stage.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    return (x / rect.width) * 100;
  }

  handle.addEventListener("pointerdown", (evt) => {
    dragging = true;
    handle.setPointerCapture(evt.pointerId);
  });
  stage.addEventListener("pointermove", (evt) => {
    if (!dragging) return;
    applyPercent(percentFromEvent(evt));
  });
  handle.addEventListener("pointerup", () => {
    dragging = false;
  });
  stage.addEventListener("pointerdown", (evt) => {
    if (evt.target === handle || handle.contains(evt.target)) return;
    applyPercent(percentFromEvent(evt));
  });

  applyPercent(50);

  return {
    setImages(sourceUrl, resultUrl) {
      if (!sourceUrl) {
        stage.style.display = "none";
        empty.style.display = "flex";
        return;
      }
      stage.style.display = "block";
      empty.style.display = "none";
      base.src = sourceUrl;
      currentResultUrl = resultUrl || null;
      if (resultUrl) {
        resultImg.src = resultUrl;
        overlay.style.display = "block";
        handle.style.display = "block";
        actions.style.display = "flex";
      } else {
        overlay.style.display = "none";
        handle.style.display = "none";
        actions.style.display = "none";
      }
    },
  };
}
