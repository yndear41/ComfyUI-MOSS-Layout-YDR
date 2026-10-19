// SPDX-License-Identifier: GPL-3.0-only
// The visual editor and interaction model adapt patterns from DENO Ideogram Director
// (https://github.com/Deno2026/comfyui-deno-custom-nodes), under GPL-3.0-only.
// This frontend has been modified for MOSS-Image layout composition.
import { app } from "/scripts/app.js";

const WIDGET = "moss_layout_editor";
const CW = 1000, CH = 1000;
const COLOR = { object: "#b0bbc0", character: "#89989e", text: "#c6cdd0" };
const TYPE_NAME = { object: "Object", character: "Character", text: "Text" };
let activeLayoutDelete = null;
const keyGuardedCanvases = new WeakMap();

function guardCanvasDeleteKey() {
  const canvas = app.canvas;
  if (!canvas) return;
  const state = keyGuardedCanvases.get(canvas) || {};
  if (!state.processKey && typeof canvas.processKey === "function") {
    const originalProcessKey = canvas.processKey;
    canvas.processKey = function (event) {
      const target = event.target;
      if (["Delete", "Backspace"].includes(event.key) && (["input", "textarea", "select"].includes(target?.localName) || target?.isContentEditable || target?.closest?.(".mb-modal-shade, .mb-color-popover"))) return;
      if (activeLayoutDelete?.(event)) return;
      return originalProcessKey.call(this, event);
    };
    state.processKey = true;
  }
  // LiteGraph binds processKey once during canvas setup. Rebind its listener so
  // the selected layout box gets first chance at Delete/Backspace.
  const originalKeyCallback = canvas._keydown_callback;
  if (typeof originalKeyCallback === "function" && originalKeyCallback !== state.keyCallback) {
    const guardedKeyCallback = (event) => {
      const target = event.target;
      if (["Delete", "Backspace"].includes(event.key) && (["input", "textarea", "select"].includes(target?.localName) || target?.isContentEditable || target?.closest?.(".mb-modal-shade, .mb-color-popover"))) return;
      if (activeLayoutDelete?.(event)) return;
      return originalKeyCallback.call(canvas, event);
    };
    document.removeEventListener("keydown", originalKeyCallback, true);
    window.removeEventListener("keydown", originalKeyCallback, true);
    canvas._keydown_callback = guardedKeyCallback;
    window.addEventListener("keydown", guardedKeyCallback, true);
    state.keyCallback = guardedKeyCallback;
  }
  keyGuardedCanvases.set(canvas, state);
}

function widget(node, name) { return node.widgets?.find((item) => item.name === name); }
function getValue(node, name, fallback) { return widget(node, name)?.value ?? fallback; }
function setValue(node, name, value) {
  const item = widget(node, name);
  if (!item) return;
  item.value = value;
  item.callback?.(value, app.canvas, node);
}
function readState(node) {
  try {
    const value = JSON.parse(getValue(node, "editor_state", "{}"));
    return Array.isArray(value.items) ? value : { items: [] };
  } catch { return { items: [] }; }
}
function linkedInput(node, name) {
  const input = node.inputs?.find((item) => item.name === name);
  return Boolean(input?.link != null);
}
function upstreamNodeIds(node, inputName) {
  const graph = node.graph || app.graph;
  const links = graph?.links || {};
  const nodes = collectNodes(graph);
  const ids = new Set();
  const visitLink = (linkId) => {
    let link = linkId;
    if (typeof linkId !== "object") {
      if (links instanceof Map) {
        const numericId = Number(linkId);
        link = links.get(linkId) ?? links.get(String(linkId)) ?? (Number.isFinite(numericId) ? links.get(numericId) : undefined);
      }
      else if (Array.isArray(links)) link = links.find((candidate) => String(candidate?.id ?? candidate?.[0]) === String(linkId));
      else link = links[linkId] ?? links[String(linkId)];
    }
    if (!link) return;
    const sourceId = link.origin_id ?? link.originId ?? link[1];
    if (sourceId == null || ids.has(String(sourceId))) return;
    ids.add(String(sourceId));
    const sourceNode = nodes.find((candidate) => String(candidate.id) === String(sourceId));
    for (const input of sourceNode?.inputs || []) if (input.link != null) visitLink(input.link);
  };
  const target = node.inputs?.find((input) => input.name === inputName);
  if (target?.link != null) visitLink(target.link);
  return ids;
}
function numberFrom(node, name, fallback) {
  const value = Number(getValue(node, name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function openColorPopover(anchor, onAdd) {
  activeColorPopoverClose?.();
  const pop = document.createElement("div");
  pop.className = "mb-color-popover";
  pop.innerHTML = `<button class="mb-pop-close" type="button" title="Close" aria-label="Close">×</button><label>Choose color</label><input class="mb-pop-color" type="color" value="#b4c0c5"><button class="mb-pop-add" type="button">＋ Add</button>`;
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  const popWidth = 190, popHeight = 112;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - popWidth - 8, rect.left))}px`;
  pop.style.top = `${rect.bottom + popHeight + 8 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - popHeight - 6)}px`;
  const close = () => { document.removeEventListener("pointerdown", outside, true); pop.remove(); if (activeColorPopoverClose === close) activeColorPopoverClose = null; };
  const outside = (event) => { if (!pop.contains(event.target) && event.target !== anchor) close(); };
  document.addEventListener("pointerdown", outside, true);
  activeColorPopoverClose = close;
  pop.addEventListener("pointerdown", (event) => event.stopPropagation());
  pop.querySelector(".mb-pop-close").onclick = close;
  pop.querySelector(".mb-pop-add").onclick = () => { onAdd(pop.querySelector(".mb-pop-color").value); close(); };
}

let activeColorPopoverClose = null;

function collectNodes(graph, output = []) {
  for (const node of graph?._nodes || []) {
    output.push(node);
    if (node.subgraph?.graph) collectNodes(node.subgraph.graph, output);
  }
  return output;
}

function previewUrl(ref) {
  if (!ref) return "";
  if (typeof ref === "string") {
    if (/^(https?:|data:|blob:|\/)/.test(ref)) return ref;
    return imageRefUrl({ filename: ref, type: "temp" });
  }
  if (ref.src) return ref.src;
  if (ref.url) return ref.url;
  if (typeof ref.data === "string" && /^data:image\//.test(ref.data)) return ref.data;
  if (ref.filename) return imageRefUrl(ref);
  return "";
}

function imageRefUrl(ref) {
  const params = new URLSearchParams();
  params.set("filename", String(ref.filename || ""));
  if (ref.subfolder) params.set("subfolder", String(ref.subfolder));
  params.set("type", String(ref.type || "input"));
  const path = `/view?${params.toString()}${app.getPreviewFormatParam?.() || ""}${app.getRandParam?.() || ""}`;
  return typeof app.api?.apiURL === "function" ? app.api.apiURL(path) : path;
}

function inputWidgetImageRef(sourceNode) {
  const imageWidget = sourceNode?.widgets?.find((item) => item.name === "image");
  let value = imageWidget?.value;
  if (typeof value !== "string" || !value.trim() || value.startsWith("$")) return null;
  value = value.trim().replace(/\s+\[(input|output|temp)\]$/i, "");
  if (/^(https?:|data:|blob:|\/)/.test(value)) return { src: value };
  let subfolder = "";
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (slash >= 0) {
    subfolder = value.slice(0, slash).replaceAll("\\", "/");
    value = value.slice(slash + 1);
  }
  return value ? { filename: value, subfolder, type: "input" } : null;
}

function nodePreviewRef(sourceNode) {
  for (const images of [sourceNode?.imgs, sourceNode?.images]) {
    const ref = Array.isArray(images) ? images.at(-1) : images;
    if (previewUrl(ref)) return ref;
  }
  return inputWidgetImageRef(sourceNode);
}

app.registerExtension({
  name: "Comfy.MOSSLayoutYDR",
  async setup() {
    guardCanvasDeleteKey();
    const emitImage = (detail) => {
      const images = detail?.output?.images;
      const nodeId = detail?.node ?? detail?.node_id ?? detail?.display_node;
      if (Array.isArray(images) && images.length) {
        window.dispatchEvent(new CustomEvent("moss-layout-output-image", { detail: { image: images.at(-1), nodeId, output: detail.output } }));
      }
      if (Array.isArray(detail?.output?.moss_layout_size)) {
        window.dispatchEvent(new CustomEvent("moss-layout-size", { detail: { nodeId, output: detail.output } }));
      }
      const importedLayouts = detail?.output?.moss_layout_import ?? detail?.output?.ui?.moss_layout_import;
      if (Array.isArray(importedLayouts) && importedLayouts.length) {
        window.dispatchEvent(new CustomEvent("moss-layout-import", { detail: { nodeId, output: detail.output } }));
      }
      window.dispatchEvent(new CustomEvent("moss-layout-refresh-background", { detail: { nodeId } }));
    };
    app.api?.addEventListener?.("executed", (event) => {
      const id = String(event.detail?.node ?? event.detail?.node_id ?? event.detail?.display_node ?? "");
      emitImage(event.detail);
      const decoded = collectNodes(app.graph).find((node) => String(node.id) === id && /vae\s*decode|vaedecode/i.test(`${node.type} ${node.comfyClass || ""} ${node.title || ""}`));
      if (!decoded) return;
      setTimeout(() => window.dispatchEvent(new CustomEvent("moss-layout-decoded", { detail: { id } })), 120);
    });
    app.api?.addEventListener?.("b_preview", (event) => {
      if (event.detail) window.dispatchEvent(new CustomEvent("moss-layout-live-preview", { detail: { blob: event.detail } }));
    });
    app.api?.addEventListener?.("b_preview_with_metadata", (event) => {
      if (event.detail?.blob) window.dispatchEvent(new CustomEvent("moss-layout-live-preview", { detail: { blob: event.detail.blob } }));
    });
  },
  async nodeCreated(node) {
    if (node.comfyClass !== "MOSSLayoutComposer" && node.type !== "MOSSLayoutComposer") return;
    if (node.widgets?.some((item) => item.name === WIDGET)) return;
    guardCanvasDeleteKey();

    // Backend widgets remain serialized and connectable; the DOM board is their compact UI.
    for (const item of node.widgets || []) {
      if (["summary", "aspect_ratio", "width", "height", "resolution", "megapixels", "dimension_multiple", "portrait", "editor_state", "summary_meta"].includes(item.name)) {
        item.computeSize = () => [0, -4];
        item.type = "hidden";
      }
    }

    const root = document.createElement("div");
    root.className = "moss-board";
    root.title = "Compose a MOSS-Image layout prompt. Draw regions, then double-click a box to edit it.";
    root.innerHTML = `
      <div class="mb-head">
        <div class="mb-control"><label title="Choose the canvas proportions. Box positions stay relative to this frame.">Aspect ratio</label><select class="mb-ratio"></select></div>
        <button class="mb-swap" title="Swap landscape and portrait orientation" aria-label="Swap orientation">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h14m0 0-3-3m3 3-3 3M20 17H6m0 0 3-3m-3 3 3 3"/><path d="m7 4 10 16"/></svg>
        </button>
      </div>
      <div class="mb-size-row">
        <div class="mb-size-group"><label title="Canvas width in pixels. Editing width or height switches the ratio to Custom.">W</label><input class="mb-width" type="number" min="64" max="16384" step="16" title="Canvas width in pixels"/><span>×</span><label title="Canvas height in pixels. Editing width or height switches the ratio to Custom.">H</label><input class="mb-height" type="number" min="64" max="16384" step="16" title="Canvas height in pixels"/></div>
        <div class="mb-bg-controls" title="Control the visibility of any image shown in the working field"><input class="mb-bg-opacity" type="range" min="0" max="100" step="1" value="100" aria-label="Background opacity" title="Background opacity"/><span class="mb-bg-opacity-label">100%</span><button class="mb-bg-eye" type="button" aria-label="Hide background" aria-pressed="true" title="Hide background"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="mb-eye-shape" d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle class="mb-eye-shape" cx="12" cy="12" r="2.7"/><path class="mb-eye-slash" d="m4 20 16-16"/></svg></button></div>
      </div>
      <div class="mb-size-row mb-mp-row">
        <label title="Select a target canvas area. The chosen aspect ratio is preserved.">Resolution</label><select class="mb-mp-select"></select><input class="mb-mp" type="number" min="0.25" max="16" step="0.05" title="Custom canvas area in megapixels"/><span>MP</span><button class="mb-clear-all" type="button" title="Clear all boxes, descriptions, prompt fields, palettes, and size choices">Clear all</button>
      </div>
      <div class="mb-main">
        <div class="mb-canvas-wrap"><canvas class="mb-canvas" width="${CW}" height="${CH}" tabindex="0" aria-label="Layout canvas"></canvas><div class="mb-empty">Draw a region by dragging on the canvas</div></div>
        <aside class="mb-prompt">
          <label title="Describe the complete image: scene, composition, lighting, style, and visual relationships.">Summary <span class="mb-info" tabindex="0" data-help="Describe the whole image in natural language: scene, composition, lighting, style, and how the elements relate. Keep box-specific appearance in each box description.">i</span></label>
          <textarea class="mb-summary" placeholder="Describe the whole image: scene, composition, lighting, and style…" title="Global description of the whole image"></textarea>
          <label title="Optional comma-separated medium or genre tags supported by MOSS-Image.">Summary metadata <span class="mb-info" tabindex="0" data-help="Optional MOSS-Image summary tags such as 'editorial photography, product campaign'. This becomes summary.meta in the JSON. Leave blank if you do not need tags.">i</span></label>
          <textarea class="mb-meta" placeholder="Optional tags, e.g. editorial photography, product campaign" title="Optional medium or genre tags, separated by commas"></textarea>
          <label title="Optional MOSS canvas structure hint. Choose single image, multi-panel layout, or collage.">Canvas structure</label>
          <select class="mb-canvas-type" title="Optional MOSS summary.canvas hint"><option value="">Not specified</option><option value="single">Single</option><option value="multi_panel">Multi-panel</option><option value="collage">Collage</option></select>
          <label title="Optional whole-image palette sent as summary.palette.">Summary palette</label><div class="mb-global-palette"></div><div class="mb-palette-tools"><button class="mb-add-summary-color" type="button" title="Add a color to the whole-image palette">＋ Add color</button><button class="mb-pick-summary" type="button" title="Sample a color from the preview">⌖ Sample</button></div><label>Elements</label><div class="mb-elements" aria-label="Layout elements"></div><div class="mb-preview-note" aria-live="polite">Waiting for a decoded image preview</div>
          <div class="mb-advanced"><button class="mb-state-toggle" type="button" title="Show or hide the saved editor state">Advanced ▸</button><textarea class="mb-state" spellcheck="false" aria-label="Saved editor state" title="Raw saved box state. Usually no editing is needed."></textarea></div>
        </aside>
      </div>
    `;
    const css = document.createElement("style");
    css.textContent = `
      .moss-board{--bg:#121619;--panel:#191e20;--line:rgba(255,255,255,.10);--text:#d3d8da;--muted:#818b8f;--accent:#9eafb4;width:100%;min-width:0;box-sizing:border-box;padding:9px;border:1px solid rgba(255,255,255,.09);border-radius:8px;background:var(--bg);color:var(--text);font:12px/1.4 "Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;gap:8px}
      .moss-board *{box-sizing:border-box}.mb-head{display:flex;align-items:end;gap:7px}.mb-control{display:flex;flex-direction:column;gap:4px;flex:1}.moss-board label{font-size:11px;color:#b5bec1}.moss-board select,.moss-board input,.moss-board textarea{background:#1b2022;color:#d3d8da;border:1px solid var(--line);border-radius:6px;min-width:0;font:inherit;padding:6px}.moss-board select:focus,.moss-board input:focus,.moss-board textarea:focus{outline:1px solid rgba(158,175,180,.7);border-color:rgba(158,175,180,.45)}
      .mb-swap{width:31px;height:31px;padding:5px;flex:0 0 31px;background:#1b2022;border:1px solid var(--line);border-radius:7px;color:#c0c9cb;cursor:pointer}.mb-swap:hover{color:var(--accent);border-color:rgba(158,175,180,.45)}.mb-swap svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round}
      .mb-size-row{display:flex;align-items:center;gap:6px;min-height:30px}.mb-size-group{display:flex;align-items:center;gap:6px;flex:1;min-width:0}.mb-size-group label{flex:0 0 auto}.mb-size-group input{flex:1;width:auto;min-width:42px}.mb-size-group span,.mb-mp-row>span{color:var(--muted)}.mb-bg-controls{display:flex;align-items:center;gap:4px;flex:0 0 auto}.mb-bg-opacity{width:74px;height:16px;padding:0!important;accent-color:#9eafb4}.mb-bg-opacity-label{width:31px;text-align:right;color:var(--muted);font-size:10px}.mb-bg-eye{display:grid;place-items:center;width:27px;height:27px;padding:4px;background:#1b2022;border:1px solid var(--line);border-radius:6px;color:#c0c9cb;cursor:pointer}.mb-bg-eye:hover{color:var(--accent);border-color:rgba(158,175,180,.45)}.mb-bg-eye svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.mb-eye-slash{display:none}.mb-bg-eye.is-hidden .mb-eye-shape{opacity:.45}.mb-bg-eye.is-hidden .mb-eye-slash{display:block}.mb-mp-row select{flex:1;min-width:0}.mb-mp-row input{width:68px}.mb-clear-all{flex:0 0 auto;background:#1d2325;color:#cbd4d7;border:1px solid var(--line);border-radius:6px;padding:5px 7px;cursor:pointer;font:inherit}.mb-clear-all:hover{border-color:rgba(158,175,180,.45);color:#fff}
      .mb-main{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(170px,1fr);gap:9px;min-height:300px;align-items:start}.mb-canvas-wrap{position:relative;min-width:0;width:100%;aspect-ratio:1/1;align-self:start;min-height:0;border:1px solid var(--line);border-radius:7px;background:#0e1214;overflow:hidden;display:grid;place-items:center}.mb-canvas{display:block;width:100%;height:100%;aspect-ratio:1/1;max-height:none;object-fit:fill;touch-action:none;cursor:crosshair}.mb-empty{position:absolute;pointer-events:none;opacity:.35;color:#b9c2c4;font-size:11px}.mb-prompt{display:flex;flex-direction:column;gap:5px;min-width:0}.mb-prompt textarea{width:100%;resize:vertical}.mb-summary{flex:1;min-height:130px}.mb-meta{min-height:60px}.mb-info{display:inline-grid;place-items:center;border:1px solid rgba(255,255,255,.25);border-radius:50%;width:14px;height:14px;font:italic 11px Georgia;color:#a5afb2;cursor:help}.mb-preview-note{font-size:10px;color:#899498;margin-top:auto}.mb-advanced{display:flex;flex-direction:column;gap:5px}.mb-state-toggle{align-self:flex-start;background:none;border:0;color:#8f999c;font:10px inherit;cursor:pointer;padding:2px}.mb-state{display:none;width:100%;height:70px;resize:vertical;font:10px monospace!important}.mb-state.open{display:block}
      .mb-modal-shade{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.52);display:grid;place-items:center}.mb-modal{position:relative;width:min(420px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#14191b;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 14px 44px #0009;padding:14px;color:#d3d8da;font:12px/1.45 "Segoe UI",system-ui,sans-serif}.mb-modal h3{margin:0 30px 9px 0;font-size:14px;font-weight:600}.mb-modal label{display:block;color:#b5bec1;margin:10px 0 4px}.mb-modal select,.mb-modal input,.mb-modal textarea{width:100%;background:#1b2022;color:#d3d8da;border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:7px;font:inherit}.mb-modal textarea{min-height:70px;resize:vertical}.mb-modal .mb-exact{min-height:56px}.mb-modal .mb-modal-help{color:#8e999c;font-size:10px;margin-top:4px}.mb-modal .mb-modal-buttons{display:flex;justify-content:space-between;gap:7px;margin-top:13px}.mb-modal button{background:#202629;color:#cbd4d7;border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer}.mb-modal button.primary{background:linear-gradient(#b2c0c4,#7e9096);color:#111719;border:0;font-weight:600}.mb-modal button.danger{color:#df9696}.mb-modal .mb-modal-close{position:absolute;right:8px;top:7px;width:23px;height:23px;padding:0;display:grid;place-items:center;font-size:19px;line-height:1;background:#242a2c;border:1px solid var(--line);border-radius:5px}
      .mb-help-pop{position:fixed;z-index:100000;max-width:260px;padding:8px 10px;background:#252b2f;border:1px solid rgba(255,255,255,.13);border-radius:7px;color:#d3d8da;font:11px/1.45 "Segoe UI",system-ui,sans-serif;box-shadow:0 6px 20px #0008;pointer-events:none}
      .mb-prompt{max-height:460px;overflow:auto;padding-right:3px}.mb-palette-tools{display:flex;align-items:center;gap:6px}.mb-palette-tools button{background:#1d2325;color:#cbd4d7;border:1px solid var(--line);border-radius:6px;padding:5px 8px;cursor:pointer;font:inherit}.mb-palette-list{display:flex;flex-wrap:wrap;gap:4px}.mb-color-chip{display:inline-flex;align-items:center;gap:3px}.mb-color-chip input[type=color]{padding:2px;width:30px;height:27px;cursor:pointer}.mb-color-chip button{border:0;background:transparent;color:#b5bec1;cursor:pointer;padding:0 3px}.mb-elements{display:flex;flex-direction:column;gap:4px;max-height:120px;overflow:auto}.mb-element{border:1px solid var(--line);background:#1d2325;color:#cbd4d7;border-radius:5px;padding:5px 7px;text-align:left;cursor:pointer;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mb-element.selected{border-color:var(--accent);color:#fff}
      .mb-color-popover{position:fixed;z-index:100001;width:190px;padding:12px;background:#171d1f;border:1px solid rgba(255,255,255,.18);border-radius:8px;box-shadow:0 8px 28px #000a;color:#d4dadd;font:12px/1.4 "Segoe UI",system-ui,sans-serif;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.mb-color-popover label{grid-column:1/-1;margin:0;color:#b5bec1}.mb-color-popover input[type=color]{width:100%;height:30px;padding:2px;background:#202629;border:1px solid var(--line);border-radius:5px}.mb-color-popover button{background:#252c2e;color:#d1d7d9;border:1px solid var(--line);border-radius:5px;padding:5px 8px;cursor:pointer;font:inherit}.mb-color-popover .mb-pop-close{position:absolute;right:5px;top:5px;width:20px;height:20px;padding:0;font-size:17px;line-height:1}.mb-color-popover label{padding-right:24px}.mb-elements{display:flex;flex-direction:column;gap:4px;max-height:120px;overflow:auto}.mb-element{border:1px solid var(--line);background:#1d2325;color:#cbd4d7;border-radius:5px;padding:5px 7px;text-align:left;cursor:pointer;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mb-element.selected{border-color:var(--accent);color:#fff}
      @media(max-width:570px){.mb-main{grid-template-columns:minmax(0,1fr)}.mb-canvas-wrap{min-height:230px}.mb-prompt{min-height:210px}.mb-summary{min-height:90px}}
      /* Keep the editor inside the resizable node in both Legacy and Node 2.0. */
      .moss-board{height:100%;min-height:0;overflow:hidden}
      .mb-head,.mb-size-row{flex:0 0 auto}
      .mb-main{grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);flex:1 1 0;min-height:0;align-items:stretch;overflow:hidden}
      .mb-canvas-wrap{height:100%;min-height:0;aspect-ratio:auto;align-self:stretch}
      .mb-canvas{width:auto;height:auto;max-width:100%;max-height:100%;aspect-ratio:1/1;object-fit:contain}
      .mb-prompt{height:100%;max-height:none;min-height:0;overflow:auto;overscroll-behavior:contain}
      .mb-summary{flex:1 1 70px;min-height:54px}
      .mb-meta{min-height:48px}
      .mb-preview-note{margin-top:4px}
      .mb-advanced{flex:0 0 auto;margin-top:4px}
      @media(max-width:570px){.mb-main{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}.mb-canvas-wrap{min-height:0}.mb-prompt{min-height:0}.mb-summary{min-height:54px}}
    `;
    root.append(css);
    const getBoardSize = () => {
      const nodeWidth = Number(node.size?.[0]) || 580;
      const nodeHeight = Number(node.size?.[1]) || 580;
      return [Math.max(220, nodeWidth - 18), Math.max(180, nodeHeight - 38)];
    };
    const previousOnResize = node.onResize;
    let resizeFrame = 0;
    const syncBoardSize = () => {
      const [width, height] = getBoardSize();
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
      node.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
    };
    const onNodeResize = function (...args) {
      const result = previousOnResize?.apply(this, args);
      syncBoardSize();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        syncBoardSize();
      });
      return result;
    };
    const domWidget = node.addDOMWidget(WIDGET, "MOSS_LAYOUT_EDITOR", root, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => 180,
      getHeight: () => "100%",
      afterResize: syncBoardSize,
    });
    // Keep a small, stable Legacy minimum so the widget never prevents node shrinking.
    // The visible DOM board itself follows node.size via the resize hooks above.
    domWidget.computeSize = () => [220, 180];
    node.onResize = onNodeResize;
    syncBoardSize();

    const $ = (selector) => root.querySelector(selector);
    const canvas = $(".mb-canvas"), ctx = canvas.getContext("2d");
    const ratioSelect = $(".mb-ratio"), wInput = $(".mb-width"), hInput = $(".mb-height");
    const mpSelect = $(".mb-mp-select"), mpInput = $(".mb-mp"), summary = $(".mb-summary"), meta = $(".mb-meta"), canvasType = $(".mb-canvas-type");
    const opacitySlider = $(".mb-bg-opacity"), opacityLabel = $(".mb-bg-opacity-label"), eyeButton = $(".mb-bg-eye");
    const savedState = $(".mb-state"), stateToggle = $(".mb-state-toggle"), emptyHint = $(".mb-empty");
    let state = readState(node), selected = -1, gesture = null, latestPreview = null, showHelp = null, sampleMode = null, previewRect = null;
    let backgroundPinned = false, previewSerial = 0, previewBlobUrl = null, lastAutoPreview = null;
    let summaryPalette = Array.isArray(state.summaryPalette) ? state.summaryPalette : [];
    const clampPercent = (value, fallback = 100) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : fallback;
    let backgroundOpacity = clampPercent(state.backgroundOpacity);
    let backgroundVisible = state.backgroundVisible !== false;
    if (!Array.isArray(state.items)) state.items = [];

    const ratioOptions = ["1:1", "2:3", "3:4", "3:5", "4:5", "5:7", "5:8", "7:9", "9:16", "9:19", "9:21", "9:32", "Custom"];
    const mpOptions = ["0.5 MP", "0.75 MP", "1 MP", "1.25 MP", "1.5 MP", "2 MP", "2.5 MP", "3 MP", "4 MP", "6 MP", "8 MP", "Custom"];
    for (const value of ratioOptions) ratioSelect.add(new Option(value, value));
    for (const value of mpOptions) mpSelect.add(new Option(value, value));

    function ratioValue() {
      const m = String(ratioSelect.value).match(/(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)/);
      if (!m) return numberFrom(node, "width", 1024) / Math.max(1, numberFrom(node, "height", 1024));
      return parseFloat(m[1]) / parseFloat(m[2]);
    }
    function roundDimension(value, roundDown = false) {
      const quantum = 16, units = Number(value) / quantum;
      return Math.max(64, (roundDown ? Math.floor(units) : Math.floor(units + .5)) * quantum);
    }
    function calculatedSize() {
      const r = ratioSelect.value === "Custom"
        ? (Number(wInput.value) || 1024) / Math.max(1, Number(hInput.value) || 1024)
        : ratioValue();
      const mp = mpSelect.value === "Custom" ? Math.max(.25, Number(mpInput.value) || 1) : parseFloat(mpSelect.value);
      const width = Math.sqrt(mp * 1e6 * r);
      const fitImageMegapixels = linkedInput(node, "background_resize");
      return [roundDimension(width, fitImageMegapixels), roundDimension(width / r, fitImageMegapixels)];
    }
    function syncWidgets() {
      setValue(node, "aspect_ratio", ratioSelect.value);
      setValue(node, "resolution", mpSelect.value);
      setValue(node, "width", roundDimension(wInput.value));
      setValue(node, "height", roundDimension(hInput.value));
      setValue(node, "megapixels", Math.max(.25, Number(mpInput.value) || 1));
      setValue(node, "dimension_multiple", "16");
      setValue(node, "summary", summary.value);
      setValue(node, "summary_meta", meta.value);
      state.summaryPalette = summaryPalette;
      if (canvasType.value) state.summaryCanvas = canvasType.value;
      else delete state.summaryCanvas;
      state.backgroundOpacity = backgroundOpacity;
      state.backgroundVisible = backgroundVisible;
      setValue(node, "portrait", false);
      savedState.value = JSON.stringify(state);
      setValue(node, "editor_state", savedState.value);
      node.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
    }
    function syncSizeFields(updateWidgets = true) {
      const [w, h] = calculatedSize();
      wInput.value = w; hInput.value = h;
      if (updateWidgets) syncWidgets();
      draw();
    }

    function fieldRect() {
      const r = ratioSelect.value === "Custom" ? (Number(wInput.value) || 1024) / Math.max(1, Number(hInput.value) || 1024) : ratioValue();
      const w = r >= CW / CH ? CW : CH * r, h = w / r;
      return { x: (CW - w) / 2, y: (CH - h) / 2, w, h };
    }
    function boxPx(box) {
      const r = fieldRect();
      return [r.x + box[0] * r.w, r.y + box[1] * r.h, r.x + box[2] * r.w, r.y + box[3] * r.h];
    }
    function canvasPoint(event) {
      const cr = canvas.getBoundingClientRect();
      const x = (event.clientX - cr.left) * CW / cr.width, y = (event.clientY - cr.top) * CH / cr.height;
      const r = fieldRect();
      return { px: x, py: y, x: Math.max(0, Math.min(1, (x - r.x) / r.w)), y: Math.max(0, Math.min(1, (y - r.y) / r.h)), inside: x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h };
    }
    function paintPreview() {
      if (!latestPreview?.complete || !latestPreview.naturalWidth) return;
      const r = fieldRect(), scale = Math.min(r.w / latestPreview.naturalWidth, r.h / latestPreview.naturalHeight);
      const w = latestPreview.naturalWidth * scale, h = latestPreview.naturalHeight * scale;
      previewRect = {x:r.x+(r.w-w)/2,y:r.y+(r.h-h)/2,w,h};
      if (!backgroundVisible || backgroundOpacity <= 0) return;
      ctx.save(); ctx.globalAlpha = backgroundOpacity / 100; ctx.drawImage(latestPreview, previewRect.x, previewRect.y, w, h); ctx.restore();
    }
    function draw() {
      ctx.clearRect(0, 0, CW, CH);
      ctx.fillStyle = "#0e1214"; ctx.fillRect(0, 0, CW, CH);
      const r = fieldRect();
      ctx.fillStyle = "#252b2d"; ctx.fillRect(r.x, r.y, r.w, r.h);
      paintPreview();
      ctx.strokeStyle = "rgba(205,216,219,.46)"; ctx.lineWidth = 1.5; ctx.setLineDash([7, 6]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]);
      state.items.forEach((item, index) => {
        const [x1, y1, x2, y2] = boxPx(item.bbox || [0, 0, 1, 1]);
        const color = COLOR[item.label] || COLOR.object;
        ctx.fillStyle = color; ctx.globalAlpha = .13; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); ctx.globalAlpha = 1;
        ctx.strokeStyle = color; ctx.lineWidth = index === selected ? 2.6 : 1.7; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const boxWidth = Math.max(0, x2 - x1), boxHeight = Math.max(0, y2 - y1);
        const palette=(item.palette||[]).filter(c=>/^#[0-9a-f]{6}$/i.test(c));
        ctx.save(); ctx.beginPath(); ctx.rect(x1, y1, boxWidth, boxHeight); ctx.clip();
        if (palette.length) {
          const stripeHeight = Math.min(7, boxHeight);
          palette.forEach((c,i)=>{ctx.fillStyle=c;ctx.fillRect(x1+boxWidth*i/palette.length,y1,boxWidth/palette.length+1,stripeHeight);});
        }
        const description = String(item.caption || "").replace(/\s+/g, " ").trim();
        const literalText = String(item.text || "").replace(/\s+/g, " ").trim();
        const label = `${TYPE_NAME[item.label] || "Object"} ${index + 1}${description ? `: ${description}` : (literalText ? `: ${literalText}` : "")}${description && literalText ? ` — ${literalText}` : ""}`;
        const textWidth = Math.max(12, boxWidth - 8), lineHeight = 12;
        ctx.font = "600 10px Segoe UI, sans-serif";
        const words = label.split(/\s+/); const lines = []; let line = "";
        const maxLines = Math.max(1, Math.floor(Math.max(1, boxHeight - 8) / lineHeight));
        let wordIndex = 0;
        for (; wordIndex < words.length; wordIndex++) {
          const candidate = line ? `${line} ${words[wordIndex]}` : words[wordIndex];
          if (line && ctx.measureText(candidate).width > textWidth) { lines.push(line); line = words[wordIndex]; if (lines.length >= maxLines) break; }
          else line = candidate;
        }
        if (line && lines.length < maxLines) lines.push(line);
        const truncated = wordIndex < words.length;
        if (truncated && lines.length) {
          let last = lines.at(-1);
          while (last && ctx.measureText(`${last}…`).width > textWidth) last = last.slice(0, -1);
          lines[lines.length - 1] = `${last}…`;
        }
        const bandY = y1 + Math.min(7, boxHeight), bandHeight = Math.min(Math.max(0, boxHeight - Math.min(7, boxHeight)), lines.length * lineHeight + 3);
        const smallBox = boxWidth < 70 || boxHeight < 22;
        if (!smallBox) {
          ctx.fillStyle = "rgba(12,16,18,.78)"; ctx.fillRect(x1, bandY, boxWidth, bandHeight);
          ctx.fillStyle = "#e3e9eb";
          lines.forEach((text, i) => ctx.fillText(text, x1 + 4, bandY + 10 + i * lineHeight, textWidth));
        }
        ctx.restore();
        if (smallBox) {
          ctx.save(); ctx.beginPath(); ctx.rect(0, 0, CW, CH); ctx.clip();
          ctx.font = "600 10px Segoe UI, sans-serif";
          const badgeText = label;
          let fittedText = badgeText;
          const badgeMaxWidth = Math.min(240, CW - 8);
          while (fittedText.length > 1 && ctx.measureText(`${fittedText}…`).width > badgeMaxWidth - 10) fittedText = fittedText.slice(0, -1);
          if (fittedText.length < badgeText.length) fittedText = `${fittedText}…`;
          const badgeWidth = Math.min(badgeMaxWidth, ctx.measureText(fittedText).width + 10);
          const badgeX = Math.max(4, Math.min(CW - badgeWidth - 4, x1));
          const badgeY = y1 >= 18 ? y1 - 17 : Math.min(CH - 15, y2 + 2);
          ctx.fillStyle = "rgba(12,16,18,.88)"; ctx.fillRect(badgeX, badgeY, badgeWidth, 14);
          ctx.fillStyle = "#e3e9eb"; ctx.fillText(fittedText, badgeX + 5, badgeY + 10, badgeWidth - 10);
          ctx.restore();
        }
        if (index === selected) {
          ctx.fillStyle = "#e5ecee";
          for (const [x, y] of [[x1,y1],[x2,y1],[x1,y2],[x2,y2]]) { ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); }
        }
      });
      if (gesture?.mode === "create" && gesture.current) {
        const frame = fieldRect(), a = gesture.start, b = gesture.current;
        const x = frame.x + Math.min(a.x,b.x)*frame.w, y = frame.y + Math.min(a.y,b.y)*frame.h;
        const w = Math.abs(a.x-b.x)*frame.w, h = Math.abs(a.y-b.y)*frame.h;
        ctx.fillStyle = "rgba(158,175,180,.12)"; ctx.fillRect(x,y,w,h);
        ctx.strokeStyle = "#9eafb4"; ctx.lineWidth = 1.8; ctx.setLineDash([5,4]); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
      }
      emptyHint.style.display = state.items.length ? "none" : "block";
      renderSidebar();
      const resolution = `${roundDimension(wInput.value)} × ${roundDimension(hInput.value)} px`;
      $(".mb-size-row").title = `Canvas size: ${resolution}`;
    }

    function saveState() { savedState.value = JSON.stringify(state); syncWidgets(); draw(); }
    function renderSidebar(){const list=$(".mb-elements");list.innerHTML="";state.items.forEach((item,i)=>{const b=document.createElement("button");b.type="button";b.className="mb-element"+(i===selected?" selected":"");b.textContent=`${TYPE_NAME[item.label]||"Object"} ${i+1}: ${item.caption||item.text||"(no description)"}`;b.onclick=()=>{selected=i;canvas.focus();draw();};b.ondblclick=()=>openEditor(i,innerWidth/2,innerHeight/2);list.append(b);});const pal=$(".mb-global-palette");pal.innerHTML="";summaryPalette.forEach((color,i)=>{const chip=document.createElement("span");chip.className="mb-color-chip";chip.innerHTML=`<input type="color" value="${/^#[0-9a-f]{6}$/i.test(color)?color:"#b4c0c5"}"><button type="button" title="Remove color">×</button>`;chip.querySelector("input").oninput=e=>{summaryPalette[i]=e.target.value;syncWidgets();};chip.querySelector("button").onclick=()=>{summaryPalette.splice(i,1);syncWidgets();draw();};pal.append(chip);});}
    function boxAt(x, y, alt) {
      const hits = [];
      for (let i = state.items.length - 1; i >= 0; i--) {
        const [x1,y1,x2,y2] = boxPx(state.items[i].bbox);
        if (x >= x1 && x <= x2 && y >= y1 && y <= y2) hits.push(i);
      }
      if (!hits.length) return -1;
      if (alt && selected >= 0) { const pos = hits.indexOf(selected); return hits[(pos + 1) % hits.length]; }
      return hits[0];
    }
    function edgeAt(box, x, y) {
      const [x1,y1,x2,y2] = boxPx(box);
      const nearL = Math.abs(x-x1) < 10, nearR = Math.abs(x-x2) < 10;
      const nearT = Math.abs(y-y1) < 10, nearB = Math.abs(y-y2) < 10;
      if ((nearL||nearR) && (nearT||nearB)) return `${nearT?"t":"b"}${nearL?"l":"r"}`;
      if (nearL) return "l"; if (nearR) return "r"; if (nearT) return "t"; if (nearB) return "b";
      return "move";
    }
    function setBoxFromPixels(item, x1, y1, x2, y2) {
      const r = fieldRect();
      item.bbox = [Math.max(0, Math.min(1, (x1-r.x)/r.w)), Math.max(0, Math.min(1, (y1-r.y)/r.h)),
                   Math.max(0, Math.min(1, (x2-r.x)/r.w)), Math.max(0, Math.min(1, (y2-r.y)/r.h))];
    }
    function createBox(start, end) {
      const item = { label: "object", caption: "", bbox: [Math.min(start.x,end.x),Math.min(start.y,end.y),Math.max(start.x,end.x),Math.max(start.y,end.y)] };
      if (item.bbox[2] - item.bbox[0] < .008 || item.bbox[3] - item.bbox[1] < .008) return;
      state.items.push(item); selected = state.items.length - 1; saveState();
    }

    function openEditor(index, clientX, clientY) {
      const item = state.items[index]; if (!item) return;
      const shade = document.createElement("div"); shade.className = "mb-modal-shade";
      const dialog = document.createElement("div"); dialog.className = "mb-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
      dialog.innerHTML = `<h3>Edit ${TYPE_NAME[item.label] || "Object"}</h3>
        <label title="MOSS item label controls whether the box describes an object, a character, or visible text.">Element type</label>
        <select class="mb-kind"><option value="object">Object</option><option value="character">Character</option><option value="text">Text</option></select>
        <div class="mb-caption-wrap"><label title="Describe the visible appearance and details inside this region.">Description</label><textarea class="mb-caption" placeholder="Describe the visible appearance, pose, materials, or typography…"></textarea><div class="mb-modal-help">This caption describes what should appear inside this box.</div></div>
        <div class="mb-exact-wrap"><label title="Enter the exact visible characters. Preserve line breaks when needed.">Exact visible text</label><textarea class="mb-exact" placeholder="Type the exact words to render…"></textarea><div class="mb-modal-help">Required for a Text element. Keep exact spelling and line breaks here.</div></div>
        <label title="Optional visual tags for this item, separated by commas.">Tags <span class="mb-modal-help">Optional comma-separated visual tags</span></label><input class="mb-tags" placeholder="e.g. foreground, warm lighting"/>
        <label title="Optional colors associated with this box.">Palette <span class="mb-modal-help">Choose colors for this element. Colors appear as a stripe on its box.</span></label><div class="mb-item-palette"></div><div class="mb-palette-tools"><button class="mb-add-item-color" type="button">＋ Add color</button></div>
        <div class="mb-modal-buttons"><button class="danger mb-delete">Delete box</button><span></span><button class="mb-cancel">Cancel</button><button class="primary mb-save">Save</button></div>`;
      shade.append(dialog); document.body.append(shade);
      const kind = dialog.querySelector(".mb-kind"), caption = dialog.querySelector(".mb-caption"), exact = dialog.querySelector(".mb-exact");
      const captionWrap = dialog.querySelector(".mb-caption-wrap"), exactWrap = dialog.querySelector(".mb-exact-wrap");
      kind.value = item.label || "object"; caption.value = item.caption || ""; exact.value = item.text || "";
      dialog.querySelector(".mb-tags").value = (item.tags || []).join(", ");
      let draftPalette = [...(item.palette || [])]; const paletteHost=dialog.querySelector(".mb-item-palette"); const renderPalette=()=>{paletteHost.innerHTML="";draftPalette.forEach((color,i)=>{const chip=document.createElement("span");chip.className="mb-color-chip";chip.innerHTML=`<input type="color" value="${/^#[0-9a-f]{6}$/i.test(color)?color:"#9eafb4"}"><button type="button" title="Remove color">×</button>`;chip.querySelector("input").oninput=e=>draftPalette[i]=e.target.value;chip.querySelector("button").onclick=()=>{draftPalette.splice(i,1);renderPalette();};paletteHost.append(chip);});};renderPalette();
      const updateType = () => {
        captionWrap.querySelector("label").textContent = kind.value === "text" ? "Text description and style" : "Description";
        captionWrap.querySelector(".mb-modal-help").textContent = kind.value === "text" ? "Describe lettering style, color, size, alignment, and surface treatment. Enter exact characters below." : "Describe the visible appearance here. Exact visible text is optional for objects and characters.";
        exactWrap.querySelector("label").textContent = kind.value === "text" ? "Exact visible text (required)" : "Exact visible text (optional)";
        exactWrap.querySelector(".mb-modal-help").textContent = kind.value === "text" ? "Required for a Text element; preserve spelling and line breaks." : "Optional literal text associated with this object or character.";
        exactWrap.style.display = "block";
      };
      updateType(); kind.addEventListener("change", updateType);
      const close = () => shade.remove();
      shade.addEventListener("pointerdown", (event) => { if (event.target === shade) { saveItem(false); saveState(); close(); } });
      dialog.querySelector(".mb-cancel").onclick = close;
      const closeButton = document.createElement("button");
      closeButton.type = "button"; closeButton.className = "mb-modal-close"; closeButton.title = "Save and close"; closeButton.setAttribute("aria-label", "Save and close"); closeButton.textContent = "×";
      dialog.insertBefore(closeButton, dialog.firstChild);
      dialog.querySelector(".mb-delete").onclick = () => { state.items.splice(index, 1); selected = -1; saveState(); close(); };
      const saveItem = (validate = true) => {
        item.label = kind.value; item.caption = caption.value.trim();
        if (exact.value.trim()) item.text = exact.value;
        else delete item.text;
        if (validate && item.label === "text" && (!item.caption || !item.text.trim())) {
          window.alert("Text elements need both typography/style and exact visible text. The box position is set on the canvas.");
          return false;
        }
        const tags = dialog.querySelector(".mb-tags").value.split(",").map((x)=>x.trim()).filter(Boolean);
        const palette = draftPalette;
        if (tags.length) item.tags = tags; else delete item.tags;
        if (palette.length) item.palette = palette; else delete item.palette;
        return true;
      };
      dialog.querySelector(".mb-modal-close").onclick = () => { saveItem(false); saveState(); close(); };
      dialog.querySelector(".mb-add-item-color").onclick = (event) => openColorPopover(event.currentTarget, (color) => { draftPalette.push(color); renderPalette(); });
      dialog.querySelector(".mb-save").onclick = () => { if (!saveItem()) return; saveState(); close(); };
      dialog.querySelector(".mb-caption").focus();
      // Keep the editor near the pointer where possible, matching the DENO board workflow.
      dialog.style.transform = `translate(${clientX < innerWidth/2 ? "4vw" : "-4vw"},0)`;
    }

    canvas.tabIndex = 0;
    canvas.addEventListener("pointerdown", (event) => {
      if (sampleMode) {
        event.stopPropagation();
        if (event.button !== 0) return;
        if (!latestPreview || !previewRect || !backgroundVisible || backgroundOpacity <= 0) {
          $(".mb-preview-note").textContent = !backgroundVisible || backgroundOpacity <= 0 ? "Show the background to sample a color" : "No preview image is available to sample";
          sampleMode = null;
          canvas.style.cursor = "crosshair";
          return;
        }
        const p = canvasPoint(event);
        if (p.px < previewRect.x || p.px > previewRect.x + previewRect.w || p.py < previewRect.y || p.py > previewRect.y + previewRect.h) return;
        try {
          const scratch = document.createElement("canvas");
          scratch.width = latestPreview.naturalWidth; scratch.height = latestPreview.naturalHeight;
          const sc = scratch.getContext("2d"); sc.drawImage(latestPreview, 0, 0);
          const ix = Math.min(scratch.width - 1, Math.floor((p.px - previewRect.x) / previewRect.w * scratch.width));
          const iy = Math.min(scratch.height - 1, Math.floor((p.py - previewRect.y) / previewRect.h * scratch.height));
          const rgb = sc.getImageData(ix, iy, 1, 1).data;
          sampleMode.target.push(`#${[...rgb].slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("")}`);
          sampleMode = null; canvas.style.cursor = "crosshair";
          $(".mb-preview-note").textContent = "Color sampled";
          syncWidgets(); draw();
        } catch (error) {
          console.warn("MOSS Layout YDR: unable to sample preview color", error);
          $(".mb-preview-note").textContent = "Could not sample this image";
          sampleMode = null; canvas.style.cursor = "crosshair";
        }
        return;
      }
      if (event.button !== 0) return;
      event.stopPropagation();
      const p = canvasPoint(event); if (!p.inside) return;
      canvas.focus();
      if (event.ctrlKey || event.metaKey) {
        gesture = { mode: "create", start: p, current: p };
        canvas.setPointerCapture(event.pointerId); return;
      }
      const hit = boxAt(p.px, p.py, event.altKey);
      if (hit >= 0) {
        selected = hit;
        const box = state.items[hit].bbox, edge = edgeAt(box, p.px, p.py);
        gesture = { mode: edge, start: p, original: [...box] };
        canvas.style.cursor = edge === "move" ? "move" : `${edge}-resize`;
        canvas.setPointerCapture(event.pointerId); draw(); return;
      }
      selected = -1; gesture = { mode: "create", start: p, current: p };
      canvas.setPointerCapture(event.pointerId); draw();
    });
    canvas.addEventListener("pointermove", (event) => {
      const p = canvasPoint(event);
      if (!gesture) { const hit=boxAt(p.px,p.py,false);canvas.style.cursor=hit>=0?(edgeAt(state.items[hit].bbox,p.px,p.py)==="move"?"move":"nwse-resize"):"crosshair";return; }
      if (gesture.mode === "create") { gesture.current = p; draw(); return; }
      const box = [...gesture.original], dx = (p.px - gesture.start.px) / fieldRect().w, dy = (p.py - gesture.start.py) / fieldRect().h;
      if (gesture.mode === "move") { box[0]+=dx;box[2]+=dx;box[1]+=dy;box[3]+=dy; }
      else { if (gesture.mode.includes("l")) box[0]+=dx;if (gesture.mode.includes("r")) box[2]+=dx;if (gesture.mode.includes("t")) box[1]+=dy;if (gesture.mode.includes("b")) box[3]+=dy; }
      const nx=Math.max(0,Math.min(1,box[0])),ny=Math.max(0,Math.min(1,box[1]));
      const ex=Math.max(0,Math.min(1,box[2])),ey=Math.max(0,Math.min(1,box[3]));
      if (gesture.mode === "move") {const bw=box[2]-box[0],bh=box[3]-box[1];box[0]=Math.max(0,Math.min(1-bw,box[0]));box[2]=box[0]+bw;box[1]=Math.max(0,Math.min(1-bh,box[1]));box[3]=box[1]+bh;}
      else {box[0]=Math.min(nx,ex);box[2]=Math.max(nx,ex);box[1]=Math.min(ny,ey);box[3]=Math.max(ny,ey);}
      state.items[selected].bbox=box;draw();
    });
    canvas.addEventListener("pointerup", (event) => {
      if (!gesture) return;
      if (gesture.mode === "create") createBox(gesture.start, gesture.current || canvasPoint(event));
      else saveState();
      gesture=null;canvas.style.cursor="crosshair";draw();
    });
    canvas.addEventListener("dblclick", (event) => {
      event.stopPropagation();const p=canvasPoint(event),hit=boxAt(p.px,p.py,event.altKey);
      if(hit>=0){selected=hit;draw();openEditor(hit,event.clientX,event.clientY);}
    });
    const deleteSelectedBox = (event) => {
      const target = event.target;
      if (activeLayoutDelete !== deleteSelectedBox || !root.isConnected || selected < 0 || !["Delete", "Backspace"].includes(event.key) || ["input", "textarea", "select"].includes(target?.localName) || target?.isContentEditable || target?.closest?.(".mb-modal-shade, .mb-color-popover")) return false;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      state.items.splice(selected, 1); selected = -1; saveState(); draw();
      return true;
    };
    const activateBoard = (event) => {
      if (root.contains(event.target)) activeLayoutDelete = deleteSelectedBox;
      else if (activeLayoutDelete === deleteSelectedBox) activeLayoutDelete = null;
    };
    document.addEventListener("pointerdown", activateBoard, true);
    document.addEventListener("keydown", deleteSelectedBox, true);

    const savedRatio = getValue(node,"aspect_ratio","1:1");
    const savedRatioPart = String(savedRatio).match(/\d+(?:\.\d+)?:\d+(?:\.\d+)?/)?.[0];
    ratioSelect.value = ratioOptions.includes(savedRatio) ? savedRatio : (ratioOptions.includes(savedRatioPart) ? savedRatioPart : "Custom");
    mpSelect.value = mpOptions.includes(getValue(node,"resolution","1 MP")) ? getValue(node,"resolution","1 MP") : "1 MP";
    wInput.value = numberFrom(node,"width",1024);hInput.value = numberFrom(node,"height",1024);mpInput.value=numberFrom(node,"megapixels",1);
    if(mpSelect.value!=="Custom")mpInput.value=parseFloat(mpSelect.value);
    wInput.step = hInput.step = "16";
    opacitySlider.value = String(backgroundOpacity);
    function updateBackgroundControls() {
      opacityLabel.textContent = `${backgroundOpacity}%`;
      eyeButton.classList.toggle("is-hidden", !backgroundVisible);
      eyeButton.setAttribute("aria-pressed", String(backgroundVisible));
      eyeButton.setAttribute("aria-label", backgroundVisible ? "Hide background" : "Show background");
      eyeButton.title = backgroundVisible ? "Hide background" : "Show background";
    }
    updateBackgroundControls();
    summary.value=getValue(node,"summary","");meta.value=getValue(node,"summary_meta","");
    canvasType.value = ["single", "multi_panel", "collage"].includes(state.summaryCanvas) ? state.summaryCanvas : "";
    ratioSelect.addEventListener("change",()=>syncSizeFields());
    mpSelect.addEventListener("change",()=>{if(mpSelect.value!=="Custom")mpInput.value=parseFloat(mpSelect.value);syncSizeFields();});
    mpInput.addEventListener("input",()=>{mpSelect.value="Custom";syncSizeFields();});
    for (const input of [wInput,hInput]) input.addEventListener("input",()=>{ratioSelect.value="Custom";mpSelect.value="Custom";mpInput.value=Math.max(.25,((Number(wInput.value)||1024)*(Number(hInput.value)||1024))/1e6).toFixed(2);syncWidgets();draw();});
    opacitySlider.addEventListener("input",()=>{backgroundOpacity=Math.max(0,Math.min(100,Number(opacitySlider.value)||0));updateBackgroundControls();syncWidgets();draw();});
    eyeButton.addEventListener("click",()=>{backgroundVisible=!backgroundVisible;updateBackgroundControls();syncWidgets();draw();});
    $(".mb-clear-all").addEventListener("click",()=>{
      const inputLinked = linkedInput(node, "layout_text");
      state = {
        items: [],
        summaryPalette: [],
        backgroundOpacity,
        backgroundVisible,
        lastLayoutInputHash: state.lastLayoutInputHash || "",
        suppressLayoutInput: inputLinked,
        suppressLayoutHash: inputLinked ? (state.lastLayoutInputHash || "") : "",
      };
      selected = -1; sampleMode = null; summary.value = ""; meta.value = ""; canvasType.value = ""; summaryPalette = [];
      ratioSelect.value = "1:1"; mpSelect.value = "1 MP"; mpInput.value = "1"; wInput.value = "1024"; hInput.value = "1024";
      syncWidgets(); draw();
    });
    function swapOrientationPreservingBoxes() {
      const oldWidth = roundDimension(wInput.value), oldHeight = roundDimension(hInput.value);
      const oldRects = state.items.map(item => {
        const b = item.bbox || [0, 0, 1, 1];
        return {cx:(b[0]+b[2])/2,cy:(b[1]+b[3])/2,w:(b[2]-b[0])*oldWidth,h:(b[3]-b[1])*oldHeight};
      });
      if (ratioSelect.value === "Custom") {
        const oldWidth = wInput.value; wInput.value = hInput.value; hInput.value = oldWidth;
      } else {
        const swapped = ratioSelect.value.replace(/(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)/,(_,a,b)=>`${b}:${a}`);
        ratioSelect.value = swapped;
        if (!ratioOptions.includes(swapped)) {
          const [width,height] = calculatedSize();
          wInput.value = width; hInput.value = height; ratioSelect.value = "Custom";
        }
      }
      const newWidth = roundDimension(wInput.value), newHeight = roundDimension(hInput.value);
      state.items.forEach((item,index)=>{
        const box=oldRects[index], bw=Math.min(box.w,newWidth), bh=Math.min(box.h,newHeight);
        const cx=Math.max(bw/2,Math.min(newWidth-bw/2,box.cx*newWidth));
        const cy=Math.max(bh/2,Math.min(newHeight-bh/2,box.cy*newHeight));
        item.bbox=[(cx-bw/2)/newWidth,(cy-bh/2)/newHeight,(cx+bw/2)/newWidth,(cy+bh/2)/newHeight];
      });
      syncWidgets();draw();
    }
    $(".mb-swap").addEventListener("click",swapOrientationPreservingBoxes);
    summary.addEventListener("input",syncWidgets);meta.addEventListener("input",syncWidgets);canvasType.addEventListener("change",syncWidgets);
    $(".mb-add-summary-color").addEventListener("click",(event)=>openColorPopover(event.currentTarget,(color)=>{summaryPalette.push(color);syncWidgets();draw();}));$(".mb-pick-summary").addEventListener("click",()=>{sampleMode={target:summaryPalette};canvas.style.cursor="copy";$(".mb-preview-note").textContent="Click the preview to sample a color";});
    savedState.addEventListener("input",()=>{try{const parsed=JSON.parse(savedState.value);if(Array.isArray(parsed.items)){state=parsed;summaryPalette=Array.isArray(parsed.summaryPalette)?parsed.summaryPalette:[];backgroundOpacity=clampPercent(parsed.backgroundOpacity);backgroundVisible=parsed.backgroundVisible!==false;opacitySlider.value=String(backgroundOpacity);updateBackgroundControls();selected=-1;setValue(node,"editor_state",savedState.value);draw();}}catch{}});
    stateToggle.addEventListener("click",()=>{savedState.classList.toggle("open");stateToggle.textContent=savedState.classList.contains("open")?"Advanced ▾":"Advanced ▸";});

    function setPreview(ref, label="Latest image preview", force=false) {
      if (backgroundPinned && !force) return;
      const isBlob = typeof Blob !== "undefined" && ref instanceof Blob;
      const url = isBlob ? URL.createObjectURL(ref) : previewUrl(ref);
      if (!url) return;
      const serial = ++previewSerial;
      const image = new Image();
      image.onload = () => {
        if (serial !== previewSerial) { if (isBlob) URL.revokeObjectURL(url); return; }
        if (previewBlobUrl && previewBlobUrl !== url) URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = isBlob ? url : null;
        latestPreview = image;
        $(".mb-preview-note").textContent = label;
        if (label === "Background Resize") {
          ratioSelect.value = "Custom";
          wInput.value = image.naturalWidth;
          hInput.value = image.naturalHeight;
          syncSizeFields();
          return;
        }
        draw();
      };
      image.onerror = () => {
        if (isBlob) URL.revokeObjectURL(url);
        if (serial === previewSerial) {
          console.warn("MOSS Layout YDR: unable to load the image for the working field", url);
          $(".mb-preview-note").textContent = `${label}: image could not be loaded`;
        }
      };
      image.src = url;
    }
    let connectedBackgroundKey = "";
    function connectedBackgroundRef(inputName) {
      const ids = upstreamNodeIds(node, inputName);
      for (const id of ids) {
        const source = collectNodes(node.graph || app.graph).find((candidate) => String(candidate.id) === String(id));
        const ref = nodePreviewRef(source);
        if (ref && previewUrl(ref)) {
          const key = ref.filename
            ? `${ref.type || "input"}:${ref.subfolder || ""}:${ref.filename}`
            : previewUrl(ref);
          return { ref, key, sourceId: id };
        }
      }
      return null;
    }
    function syncConnectedBackground() {
      const resizeConnected = linkedInput(node, "background_resize");
      const backgroundConnected = linkedInput(node, "background");
      if (!resizeConnected && !backgroundConnected) {
        backgroundPinned = false;
        connectedBackgroundKey = "";
        return;
      }
      const label = resizeConnected ? "Background Resize" : "Background";
      const resolved = connectedBackgroundRef(resizeConnected ? "background_resize" : "background");
      if (!resolved || resolved.key === connectedBackgroundKey) return;
      connectedBackgroundKey = resolved.key;
      backgroundPinned = true;
      setPreview(resolved.ref, label, true);
    }
    const onBackgroundRefresh = () => syncConnectedBackground();
    // Load Image updates node.imgs independently of the executed event. Poll only this small
    // set of connected source widgets so a changed image appears without requiring a run.
    const backgroundRefreshTimer = window.setInterval(syncConnectedBackground, 700);
    const previousOnConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const result = previousOnConnectionsChange?.apply(this, args);
      window.setTimeout(syncConnectedBackground, 0);
      window.setTimeout(syncConnectedBackground, 120);
      return result;
    };
    function storedNodePreview(id) {
      const store = app.nodePreviewImages;
      return store?.get?.(String(id)) ?? store?.get?.(id) ?? store?.[String(id)] ?? store?.[id];
    }
    function useNodePreview(id) {
      const candidate=collectNodes(app.graph).find((item)=>String(item.id)===String(id));
      if(!candidate)return;
      const refs=storedNodePreview(id) || candidate.imgs || candidate.images;
      const ref=Array.isArray(refs)?refs.at(-1):refs;
      const url=previewUrl(ref);if(url){lastAutoPreview={ref,label:"Latest decoded image"};setPreview(ref,lastAutoPreview.label);}
    }
    const onDecoded=(event)=>{
      const id=event.detail?.id;
      for(const delay of [0,120,500,1000,2000]) setTimeout(()=>useNodePreview(id),delay);
    };
    const onLivePreview=(event)=>{
      if (!linkedInput(node,"background") && !linkedInput(node,"background_resize")) backgroundPinned=false;
      lastAutoPreview={ref:event.detail?.blob,label:"Live sampler preview"};
      setPreview(event.detail?.blob,"Live sampler preview");
    };
    const onOutputImage=(event)=>{
      if (!linkedInput(node,"background") && !linkedInput(node,"background_resize")) backgroundPinned=false;
      const image=event.detail?.image;
      const imageNodeId=String(event.detail?.nodeId ?? "");
      const isOwnNode = imageNodeId.split(":").at(-1) === String(node.id).split(":").at(-1);
      if (image && isOwnNode && (linkedInput(node,"background") || linkedInput(node,"background_resize"))) {
        const isResize = linkedInput(node,"background_resize");
        backgroundPinned = true;
        setPreview(image,isResize?"Background Resize":"Background",true);
        if (isResize) {
          const output = event.detail?.output || {};
          const rawWidth = output.width ?? output.ui?.width, rawHeight = output.height ?? output.ui?.height;
          const outWidth = Number(Array.isArray(rawWidth)?rawWidth[0]:rawWidth), outHeight = Number(Array.isArray(rawHeight)?rawHeight[0]:rawHeight);
          if (outWidth > 0 && outHeight > 0) { ratioSelect.value="Custom"; wInput.value=outWidth; hInput.value=outHeight; syncWidgets(); draw(); }
        }
        return;
      }
      const resizeSources=upstreamNodeIds(node,"background_resize");
      const backgroundSources=upstreamNodeIds(node,"background");
      const imageNodeIds = new Set([imageNodeId, imageNodeId.split(":").at(-1)]);
      const sourceMatches = (ids) => [...imageNodeIds].some((id) => ids.has(id));
      if (image && linkedInput(node,"background_resize") && sourceMatches(resizeSources)) {
        backgroundPinned=true; setPreview(image,"Background Resize",true); return;
      }
      if (image && !linkedInput(node,"background_resize") && linkedInput(node,"background") && sourceMatches(backgroundSources)) {
        backgroundPinned=true; setPreview(image,"Background",true); return;
      }
      if (image && String(event.detail?.nodeId) !== String(node.id)) lastAutoPreview={ref:image,label:"Latest output image"};
      setPreview(image,"Latest output image");
    };
    window.addEventListener("moss-layout-decoded",onDecoded);
    window.addEventListener("moss-layout-live-preview",onLivePreview);
    window.addEventListener("moss-layout-output-image",onOutputImage);
    window.addEventListener("moss-layout-refresh-background",onBackgroundRefresh);
    // Also pick up the most recently decoded node when the workflow board is first opened.
    const decodedNodes=collectNodes(app.graph).filter((item)=>/vae\s*decode|vaedecode/i.test(`${item.type} ${item.comfyClass||""} ${item.title||""}`));
    for(const item of decodedNodes.reverse()){if(storedNodePreview(item.id)||item.imgs?.length){useNodePreview(item.id);break;}}

    // A connected background is intentionally explicit and takes precedence over auto preview.
    const applyBackendSize = (output) => {
      const echo = output?.moss_layout_size?.at?.(-1) ?? output?.ui?.moss_layout_size?.at?.(-1);
      const rawWidth = echo?.width ?? output?.width ?? output?.ui?.width;
      const rawHeight = echo?.height ?? output?.height ?? output?.ui?.height;
      const outWidth = Number(Array.isArray(rawWidth) ? rawWidth[0] : rawWidth);
      const outHeight = Number(Array.isArray(rawHeight) ? rawHeight[0] : rawHeight);
      if (!(outWidth > 0 && outHeight > 0)) return;
      if (echo?.layout_input_hash) {
        state.lastLayoutInputHash = echo.layout_input_hash;
        if (echo.layout_input_suppressed && state.suppressLayoutInput && !state.suppressLayoutHash) {
          state.suppressLayoutHash = echo.layout_input_hash;
        }
        savedState.value = JSON.stringify(state);
        setValue(node, "editor_state", savedState.value);
      } else if (state.suppressLayoutInput) {
        delete state.suppressLayoutInput;
        delete state.suppressLayoutHash;
        savedState.value = JSON.stringify(state);
        setValue(node, "editor_state", savedState.value);
      }
      ratioSelect.value = echo?.aspect_ratio || (linkedInput(node, "background_resize") ? "Custom" : ratioSelect.value);
      wInput.value = outWidth;
      hInput.value = outHeight;
      if (echo?.source === "wired_dimensions") {
        mpSelect.value = "Custom";
        mpInput.value = (outWidth * outHeight / 1e6).toFixed(2);
      } else if (echo?.input_megapixels_active && echo?.megapixels != null) {
        mpSelect.value = "Custom";
        mpInput.value = Number(echo.megapixels).toFixed(2);
      } else if (echo?.source === "layout_text") {
        mpSelect.value = "Custom";
        mpInput.value = (outWidth * outHeight / 1e6).toFixed(2);
      }
      syncWidgets();
      draw();
    };
    const applyBackendLayout = (output) => {
      const importPayload = output?.moss_layout_import ?? output?.ui?.moss_layout_import;
      const imported = Array.isArray(importPayload) ? importPayload.at(-1) : importPayload;
      if (!imported || !Array.isArray(imported.items)) return;
      state.items = imported.items;
      if (imported.input_hash) state.lastLayoutInputHash = imported.input_hash;
      if (imported.clear_suppression) {
        delete state.suppressLayoutInput;
        delete state.suppressLayoutHash;
      }
      if (imported.has_summary) {
        summaryPalette = Array.isArray(imported.summary?.palette) ? imported.summary.palette : [];
        summary.value = imported.summary?.caption || "";
        meta.value = Array.isArray(imported.summary?.meta) ? imported.summary.meta.join(", ") : "";
        canvasType.value = ["single", "multi_panel", "collage"].includes(imported.summary?.canvas) ? imported.summary.canvas : "";
        if (canvasType.value) state.summaryCanvas = canvasType.value;
        else delete state.summaryCanvas;
      }
      selected = -1;
      saveState();
    };
    const onBackendSize = (event) => {
      const eventId = String(event.detail?.nodeId ?? "").split(":").at(-1);
      if (eventId === String(node.id).split(":").at(-1)) applyBackendSize(event.detail?.output);
    };
    window.addEventListener("moss-layout-size", onBackendSize);
    const onBackendLayout = (event) => {
      const eventId = String(event.detail?.nodeId ?? "").split(":").at(-1);
      if (eventId === String(node.id).split(":").at(-1)) applyBackendLayout(event.detail?.output);
    };
    window.addEventListener("moss-layout-import", onBackendLayout);
    function restoreConfiguredState() {
      // The DOM editor is created before ComfyUI restores widgets_values.
      // Rebuild it after configure so execution callbacks do not overwrite the
      // restored workflow values with the temporary defaults shown at creation.
      state = readState(node);
      summaryPalette = Array.isArray(state.summaryPalette) ? state.summaryPalette : [];
      backgroundOpacity = clampPercent(state.backgroundOpacity);
      backgroundVisible = state.backgroundVisible !== false;

      const configuredRatio = getValue(node, "aspect_ratio", "1:1");
      const ratioPart = String(configuredRatio).match(/\d+(?:\.\d+)?:\d+(?:\.\d+)?/)?.[0];
      ratioSelect.value = ratioOptions.includes(configuredRatio) ? configuredRatio : (ratioOptions.includes(ratioPart) ? ratioPart : "Custom");
      const configuredResolution = getValue(node, "resolution", "1 MP");
      mpSelect.value = mpOptions.includes(configuredResolution) ? configuredResolution : "1 MP";
      wInput.value = numberFrom(node, "width", 1024);
      hInput.value = numberFrom(node, "height", 1024);
      mpInput.value = numberFrom(node, "megapixels", 1);
      if (mpSelect.value !== "Custom") mpInput.value = parseFloat(mpSelect.value);
      summary.value = getValue(node, "summary", "");
      meta.value = getValue(node, "summary_meta", "");
      canvasType.value = ["single", "multi_panel", "collage"].includes(state.summaryCanvas) ? state.summaryCanvas : "";
      canvasType.value = ["single", "multi_panel", "collage"].includes(state.summaryCanvas) ? state.summaryCanvas : "";
      opacitySlider.value = String(backgroundOpacity);
      savedState.value = JSON.stringify(state);
      selected = -1;
      updateBackgroundControls();
      renderSidebar();
      draw();
      syncConnectedBackground();
    }
    node.mossLayoutYdrRestore = restoreConfiguredState;
    const previousOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = previousOnConfigure?.apply(this, args);
      restoreConfiguredState();
      return result;
    };
    node.onExecuted = (output) => {
      const outputImages = output?.images || output?.ui?.images;
      const ref=Array.isArray(outputImages)?outputImages.at(-1):null;
      if(ref && (linkedInput(node,"background") || linkedInput(node,"background_resize"))) {
        backgroundPinned=true;
        setPreview(ref,linkedInput(node,"background_resize")?"Background Resize":"Background",true);
      } else if (!linkedInput(node,"background") && !linkedInput(node,"background_resize")) {
        backgroundPinned=false;
        if (lastAutoPreview) setPreview(lastAutoPreview.ref,lastAutoPreview.label);
      }
      applyBackendSize(output);
      applyBackendLayout(output);
      syncConnectedBackground();
    };

    const previousOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
      document.removeEventListener("pointerdown", activateBoard, true);
      document.removeEventListener("keydown", deleteSelectedBox, true);
      window.removeEventListener("moss-layout-decoded",onDecoded);
      window.removeEventListener("moss-layout-live-preview",onLivePreview);
      window.removeEventListener("moss-layout-output-image",onOutputImage);
      window.removeEventListener("moss-layout-size",onBackendSize);
      window.removeEventListener("moss-layout-import",onBackendLayout);
      window.removeEventListener("moss-layout-refresh-background",onBackgroundRefresh);
      window.clearInterval(backgroundRefreshTimer);
      if (node.onConnectionsChange !== previousOnConnectionsChange) node.onConnectionsChange = previousOnConnectionsChange;
      if (node.onResize === onNodeResize) node.onResize = previousOnResize;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (showHelp) showHelp.remove();
      if (activeLayoutDelete === deleteSelectedBox) activeLayoutDelete = null;
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
      return previousOnRemoved?.apply(this, args);
    };

    root.addEventListener("pointerdown",(event)=>event.stopPropagation());
    root.addEventListener("wheel",(event)=>event.stopPropagation(),{passive:true});
    for(const info of root.querySelectorAll(".mb-info")){
      const show=()=>{if(showHelp)showHelp.remove();const pop=document.createElement("div");pop.className="mb-help-pop";pop.textContent=info.dataset.help;document.body.append(pop);const r=info.getBoundingClientRect();pop.style.left=`${Math.min(innerWidth-270,r.left)}px`;pop.style.top=`${r.bottom+5}px`;showHelp=pop;};
      info.addEventListener("mouseenter",show);info.addEventListener("focus",show);info.addEventListener("mouseleave",()=>{showHelp?.remove();showHelp=null;});info.addEventListener("blur",()=>{showHelp?.remove();showHelp=null;});
    }
    if(ratioSelect.value!=="Custom") { const [initialWidth,initialHeight]=calculatedSize();wInput.value=initialWidth;hInput.value=initialHeight; }
    savedState.value=JSON.stringify(state);
    syncWidgets();draw();syncConnectedBackground();
  },
  afterConfigureGraph() {
    for (const node of collectNodes(app.graph)) {
      if (node.comfyClass === "MOSSLayoutComposer" || node.type === "MOSSLayoutComposer") {
        node.mossLayoutYdrRestore?.();
      }
    }
  },
});
