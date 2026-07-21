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
    </div>
    <div class="ab-empty" id="abEmpty">Select an image to begin.</div>
  `;

  const stage = container.querySelector("#abStage");
  const base = container.querySelector("#abBase");
  const resultImg = container.querySelector("#abResult");
  const overlay = container.querySelector("#abOverlay");
  const handle = container.querySelector("#abHandle");
  const empty = container.querySelector("#abEmpty");

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
      if (resultUrl) {
        resultImg.src = resultUrl;
        overlay.style.display = "block";
        handle.style.display = "block";
      } else {
        overlay.style.display = "none";
        handle.style.display = "none";
      }
    },
  };
}
