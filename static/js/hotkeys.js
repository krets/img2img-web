/** Global keyboard shortcuts for the review workflow.
 * handlers: { onYes, onNo, onMaybe, onPrev, onNext, onFocusPrompt }
 */
export function initHotkeys(handlers) {
  document.addEventListener("keydown", (evt) => {
    const tag = evt.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || evt.target.isContentEditable) return;

    switch (evt.key.toLowerCase()) {
      case "y":
        handlers.onYes?.();
        break;
      case "n":
        handlers.onNo?.();
        break;
      case "m":
        handlers.onMaybe?.();
        break;
      case "arrowleft":
        handlers.onPrev?.();
        break;
      case "arrowright":
        handlers.onNext?.();
        break;
      case "g":
        handlers.onFocusPrompt?.();
        break;
      default:
        return;
    }
    evt.preventDefault();
  });
}
