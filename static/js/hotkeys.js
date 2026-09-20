/** Global keyboard shortcuts for the review workflow.
 * handlers: { onYes, onNo, onMaybe, onPrev, onNext, onFocusPrompt, onHelp }
 */
export function initHotkeys(handlers) {
  document.addEventListener("keydown", (evt) => {
    const tag = evt.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || evt.target.isContentEditable) return;
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return; // leave browser shortcuts (Ctrl+F, Ctrl+M, ...) alone

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
      case "?":
        handlers.onHelp?.();
        break;
      default:
        return;
    }
    evt.preventDefault();
  });
}

/** Everything the help overlay shows. Documentation only -- the handlers live
 * where each feature does (this file, panels.js, app.js, preprocess.js,
 * viewer.js), so update this list when adding or changing a shortcut there.
 * A row has either `keys` (keycaps; a "+" inside one, e.g. "Ctrl+V", renders
 * as separate keycaps, and several entries are shown as "A / B") or `gesture`
 * (plain text for mouse actions).
 */
export const HOTKEY_GROUPS = [
  {
    title: "Review",
    rows: [
      { keys: ["Y"], desc: "Approve the selected image's result" },
      { keys: ["N"], desc: "Reject it" },
      { keys: ["M"], desc: "Mark it maybe" },
      { keys: ["←", "→"], desc: "Previous / next image" },
      { keys: ["G"], desc: "Focus the prompt box" },
    ],
  },
  {
    title: "General",
    rows: [
      { keys: ["F"], desc: "Maximize viewport (hide side panels)" },
      { keys: ["?"], desc: "Show / hide this help" },
      { keys: ["Esc"], desc: "Close the menu, panel or dialog" },
    ],
  },
  {
    title: "Dialogs",
    rows: [
      { keys: ["Esc"], desc: "Step back (or close, from the first step)" },
      { keys: ["←", "→"], desc: "Previous / next item in an export preview" },
    ],
  },
  {
    title: "Crop / pre-process editor",
    rows: [
      { keys: ["Enter"], desc: "Apply" },
      { keys: ["Esc"], desc: "Cancel" },
    ],
  },
  {
    title: "Projects",
    rows: [
      { keys: ["Enter"], desc: "In the search box: open the top match" },
      { keys: ["Enter"], desc: "While renaming: save" },
      { keys: ["Esc"], desc: "While renaming or confirming a delete: cancel" },
    ],
  },
  {
    title: "Prompts",
    rows: [
      { keys: ["Enter"], desc: "In the prompt list's filter box: pick the top match" },
      { keys: ["Esc"], desc: "Close the prompt list, or cancel a delete" },
    ],
  },
  {
    title: "Upload",
    rows: [
      { keys: ["Ctrl+V"], desc: "Paste an image (or image URL) into the current tab" },
      { gesture: "Drop", desc: "Drag image files onto the upload area" },
    ],
  },
  {
    title: "Viewer",
    rows: [
      { gesture: "Drag / Click", desc: "Wipe modes: move the split line" },
      { gesture: "Hold", desc: "Hold modes: press and hold the image to flip" },
      { gesture: "Drag", desc: "Panel edges: resize the side panels" },
    ],
  },
];
