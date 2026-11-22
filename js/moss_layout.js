// SPDX-License-Identifier: GPL-3.0-only
// The visual editor and interaction model adapt patterns shared by Deno2026
// (https://github.com/Deno2026/comfyui-deno-custom-nodes), under GPL-3.0-only.
// This frontend has been modified for MOSS-Image layout composition.
import { app } from "/scripts/app.js";
import { queueTextAction } from "./text_action_queue.js";

const WIDGET = "moss_layout_editor";
const NODE_TYPES = new Set(["MOSSLayoutComposer", "MOSSLayoutComposerExperimental"]);
const NODE_TITLE = "MOSS Layout YDR";
const LEGACY_NODE_TITLES = new Set([...NODE_TYPES, NODE_TITLE, "MOSS Layout YDR Experimental", "MOSS Layout YDR (Experimental)"]);
const CW = 1000, CH = 1000;
const TYPE_NAME = { object: "Object", character: "Character", text: "Text" };
const TRANSLATE_ICON = '<svg class="mb-translate-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 2.8h10.2a3 3 0 0 1 3 3v5.8a3 3 0 0 1-3 3H8l-3.3 2.7v-2.7h-1a3 3 0 0 1-3-3V5.8a3 3 0 0 1 2.8-3Z"/><path d="M10.8 9.4h9.7a3 3 0 0 1 3 3v5.8a3 3 0 0 1-3 3h-2.2v2l-3.1-2h-4.4a3 3 0 0 1-3-3"/><text x="5.7" y="10.9">A</text><text x="15.1" y="18.8">文</text></svg>';
const CONTEXT_MODES = ["none", "summary", "full"];
const CONTEXT_LABELS = ["None", "Summary", "Full"];
const FIELD_PROMPT_LABELS = {
  summary: "Summary",
  summary_meta: "Summary Metadata",
  bbox_character: "Character BBox",
  bbox_object: "Object BBox",
  bbox_text: "Text BBox",
};
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
function mergeSavedEnhancerSettings(node, state) {
  try {
    const saved = JSON.parse(getValue(node, "prompt_enhancer_settings", "{}") || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved) && Object.keys(saved).length) {
      state.promptEnhancerSettings = saved;
    }
  } catch {}
  return state;
}
function migrateLegacyTranslation(node, state) {
  const saved = state?.translated;
  const values = saved?.status === "ready" && saved.values && typeof saved.values === "object" ? saved.values : null;
  if (state?.translationView && values) {
    if (typeof values["summary.caption"] === "string") setValue(node, "summary", values["summary.caption"]);
    const rawMeta = String(getValue(node, "summary_meta", "") || "");
    const sourceMeta = rawMeta.split(",").map((entry) => entry.trim()).filter(Boolean);
    const metaOverride = values["summary.meta_override"];
    const translatedMeta = typeof metaOverride === "string" ? metaOverride
      : Array.isArray(metaOverride) ? metaOverride.join(", ")
        : sourceMeta.map((entry, index) => values[`summary.meta.${index}`] ?? entry).join(", ");
    setValue(node, "summary_meta", translatedMeta);
    (state.items || []).forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      for (const field of ["caption", "text"]) {
        const value = values[`item.${index}.${field}`];
        if (typeof value !== "string") continue;
        if (field === "text" && !value.trim()) delete item.text;
        else item[field] = value;
      }
      const tagsOverride = values[`item.${index}.tags_override`];
      if (Array.isArray(tagsOverride)) {
        if (tagsOverride.length) item.tags = tagsOverride; else delete item.tags;
      } else if (Array.isArray(item.tags)) {
        item.tags = item.tags.map((entry, tagIndex) => values[`item.${index}.tags.${tagIndex}`] ?? entry);
      }
    });
    if (linkedInput(node, "layout_text") && state.lastLayoutInputHash) {
      state.suppressLayoutInput = true;
      state.suppressLayoutHash = state.lastLayoutInputHash;
    }
  }
  if (state && typeof state === "object") {
    delete state.translated;
    delete state.translationView;
  }
  return state;
}
function readState(node) {
  try {
    const value = JSON.parse(getValue(node, "editor_state", "{}"));
    return migrateLegacyTranslation(node, mergeSavedEnhancerSettings(node, Array.isArray(value.items) ? value : { items: [] }));
  } catch { return mergeSavedEnhancerSettings(node, { items: [] }); }
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

function openColorPopover(anchor, onAdd, recentColors = []) {
  activeColorPopoverClose?.();
  const pop = document.createElement("div");
  pop.className = "mb-color-popover";
  pop.innerHTML = `<button class="mb-pop-close" type="button" title="Close" aria-label="Close">×</button><label>Choose color</label><div class="mb-picker-plane" role="application" aria-label="Color saturation and brightness"><span class="mb-picker-handle"></span></div><div class="mb-picker-hue-row"><span>Hue</span><input class="mb-picker-hue" type="range" min="0" max="360" value="195" aria-label="Hue"></div><div class="mb-picker-value-row"><span class="mb-picker-preview"></span><input class="mb-picker-hex" type="text" value="#b4c0c5" maxlength="7" aria-label="Hex color"><button class="mb-pop-add" type="button">＋ Add</button></div><div class="mb-recent-colors" aria-label="Recently used colors"></div>`;
  const recentHost = pop.querySelector(".mb-recent-colors");
  let hue = 195, saturation = 0.08, brightness = 0.77, pickedColor = "#b4c0c5";
  const hsvToHex = (h, s, v) => {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    const rgb = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x] : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
    return `#${rgb.map((value) => Math.round((value + m) * 255).toString(16).padStart(2,"0")).join("")}`;
  };
  const setColor = (color) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    pickedColor = color.toLowerCase();
    const [r,g,b] = [1,3,5].map((offset) => parseInt(pickedColor.slice(offset,offset+2),16)/255);
    const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max - min;
    hue = delta === 0 ? hue : max === r ? 60 * (((g-b)/delta) % 6) : max === g ? 60 * ((b-r)/delta+2) : 60 * ((r-g)/delta+4);
    if (hue < 0) hue += 360;
    saturation = max === 0 ? 0 : delta/max; brightness = max;
    syncPicker();
  };
  const syncPicker = () => {
    pop.querySelector(".mb-picker-plane").style.backgroundColor = `hsl(${hue} 100% 50%)`;
    pop.querySelector(".mb-picker-handle").style.left = `${saturation*100}%`;
    pop.querySelector(".mb-picker-handle").style.top = `${(1-brightness)*100}%`;
    pop.querySelector(".mb-picker-hue").value = String(Math.round(hue));
    pop.querySelector(".mb-picker-hex").value = pickedColor;
    pop.querySelector(".mb-picker-preview").style.backgroundColor = pickedColor;
  };
  const setFromPlane = (event) => {
    const rect = pop.querySelector(".mb-picker-plane").getBoundingClientRect();
    saturation = Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));
    brightness = 1-Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height));
    pickedColor = hsvToHex(hue,saturation,brightness); syncPicker();
  };
  const plane = pop.querySelector(".mb-picker-plane");
  plane.addEventListener("pointerdown",(event)=>{event.preventDefault();plane.setPointerCapture(event.pointerId);setFromPlane(event);});
  plane.addEventListener("pointermove",(event)=>{if(event.buttons&1)setFromPlane(event);});
  pop.querySelector(".mb-picker-hue").addEventListener("input",(event)=>{hue=Number(event.currentTarget.value);pickedColor=hsvToHex(hue,saturation,brightness);syncPicker();});
  pop.querySelector(".mb-picker-hex").addEventListener("input",(event)=>setColor(event.currentTarget.value));
  syncPicker();
  for (let index = 0; index < 10; index++) {
    const color = recentColors[index];
    const swatch = document.createElement("button");
    swatch.type = "button"; swatch.className = "mb-recent-swatch"; swatch.style.backgroundColor = color;
    if (/^#[0-9a-f]{6}$/i.test(color || "")) {
      swatch.title = `Select ${color}`; swatch.setAttribute("aria-label", `Select color ${color}`);
      swatch.addEventListener("click", () => setColor(color));
    } else {
      swatch.disabled = true; swatch.classList.add("is-empty"); swatch.title = "No recent color"; swatch.setAttribute("aria-label", "Empty recent color slot");
    }
    recentHost.append(swatch);
  }
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - popRect.width - 8, rect.left))}px`;
  pop.style.top = `${rect.bottom + popRect.height + 8 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - popRect.height - 6)}px`;
  const close = () => { document.removeEventListener("pointerdown", outside, true); pop.remove(); if (activeColorPopoverClose === close) activeColorPopoverClose = null; };
  const outside = (event) => { if (!pop.contains(event.target) && event.target !== anchor) close(); };
  document.addEventListener("pointerdown", outside, true);
  activeColorPopoverClose = close;
  pop.addEventListener("pointerdown", (event) => event.stopPropagation());
  pop.querySelector(".mb-pop-close").onclick = close;
  pop.querySelector(".mb-pop-add").onclick = () => { onAdd(pickedColor); close(); };
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
      const replacements = detail?.output?.moss_layout_replace ?? detail?.output?.ui?.moss_layout_replace;
      if (Array.isArray(replacements) && replacements.length) {
        window.dispatchEvent(new CustomEvent("moss-layout-replace", { detail: { nodeId, output: detail.output } }));
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
    if (!NODE_TYPES.has(node.comfyClass) && !NODE_TYPES.has(node.type)) return;
    const updateDefaultTitle = () => {
      if (!node.title || LEGACY_NODE_TITLES.has(node.title)) node.title = NODE_TITLE;
    };
    updateDefaultTitle();
    // Existing workflow JSON stores socket lists on each node. Migrate old
    // saved instances to the current backend schema when ComfyUI restores them.
    for (let index = (node.outputs?.length || 0) - 1; index >= 0; index--) {
      const name = String(node.outputs[index]?.name || "").trim().toLowerCase();
      if (["translated", "translated_json", "translated_prompt"].includes(name)) node.removeOutput?.(index);
    }
    if (!node.inputs?.some((input) => input.name === "clip")) node.addInput?.("clip", "CLIP");
    if (node.widgets?.some((item) => item.name === WIDGET)) return;
    guardCanvasDeleteKey();

    // Backend widgets remain serialized and connectable; the DOM board is their compact UI.
    for (const item of node.widgets || []) {
      if (["summary", "aspect_ratio", "width", "height", "resolution", "megapixels", "dimension_multiple", "portrait", "editor_state", "prompt_enhancer_settings", "summary_meta"].includes(item.name)) {
        item.computeSize = () => [0, -4];
        item.type = "hidden";
      }
    }

    const root = document.createElement("div");
    root.className = "moss-board";
    root.title = "Compose a MOSS-Image layout. Draw regions and double-click to edit; use the mouse wheel to zoom the workflow and hold Space while dragging to pan.";
    const progressGradientId = `moss-enhancer-gradient-${String(node.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    root.innerHTML = `
      <div class="mb-head">
        <div class="mb-control"><label title="Choose the generation field proportions. The working field and box positions stay fixed.">Aspect ratio</label><select class="mb-ratio"></select></div>
        <button class="mb-swap" title="Swap landscape and portrait orientation" aria-label="Swap orientation">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h14m0 0-3-3m3 3-3 3M20 17H6m0 0 3-3m-3 3 3 3"/><path d="m7 4 10 16"/></svg>
        </button>
      </div>
      <div class="mb-size-row">
        <div class="mb-size-group"><label title="Canvas width in pixels. Editing width or height switches the ratio to Custom.">W</label><input class="mb-width" type="number" min="64" max="16384" step="16" title="Canvas width in pixels"/><span>×</span><label title="Canvas height in pixels. Editing width or height switches the ratio to Custom.">H</label><input class="mb-height" type="number" min="64" max="16384" step="16" title="Canvas height in pixels"/></div>
        <div class="mb-bg-controls" title="Control the visibility of any image shown in the working field"><input class="mb-bg-opacity" type="range" min="0" max="100" step="1" value="100" aria-label="Background opacity" title="Background opacity"/><span class="mb-bg-opacity-label">100%</span><button class="mb-bg-eye" type="button" aria-label="Hide background" aria-pressed="true" title="Hide background"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="mb-eye-shape" d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle class="mb-eye-shape" cx="12" cy="12" r="2.7"/><path class="mb-eye-slash" d="m4 20 16-16"/></svg></button></div>
      </div>
      <div class="mb-size-row mb-mp-row">
        <label title="MOSS-Image is most reliable around 1–2 MP and is documented to extrapolate to about 4 MP. Higher sizes need more memory and may lose detail.">Resolution</label><select class="mb-mp-select"></select><input class="mb-mp" type="number" min="0.25" max="16" step="0.05" title="Custom canvas area in megapixels. 1–2 MP is a good starting range for MOSS-Image."/><span>MP</span><button class="mb-clear-all" type="button" title="Clear all boxes, descriptions, prompt fields, palettes, and size choices">Clear all</button>
      </div>
      <div class="mb-main">
        <div class="mb-canvas-wrap"><canvas class="mb-canvas" width="${CW}" height="${CH}" tabindex="0" aria-label="Layout canvas"></canvas><div class="mb-empty">Draw a region by dragging on the canvas</div></div>
        <aside class="mb-prompt">
          <div class="mb-translation-row"><button class="mb-translate-all" type="button" title="Translate and replace all filled prompt fields">Translate all</button><button class="mb-translate-settings" type="button" title="Edit shared translation settings" aria-label="Translation settings">⚙</button></div>
          <div class="mb-translation-row mb-enhancer-row"><button class="mb-enhance-all" type="button" title="Generate improved text for every filled field with the CLIP encoder connected to this node">Generate all</button><button class="mb-edit-matching" type="button" title="Edit filled fields using keyword matches, manual selections, or all fields">Edit</button><button class="mb-enhancer-settings" type="button" title="Edit shared text generation settings" aria-label="Text generation settings">⚙</button><div class="mb-inline-context" title="No context sends only the target field; Summary adds caption and metadata; Full layout adds all boxes and coordinates."><span class="mb-inline-context-title">Context</span><input class="mb-context-slider" type="range" min="0" max="2" step="1" value="2" aria-label="Generation context"><span class="mb-inline-context-value">Full</span></div><span class="mb-enhancer-progress" role="progressbar" aria-label="Text action progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="${progressGradientId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f0b2cc"/><stop offset="52%" stop-color="#9f456e"/><stop offset="100%" stop-color="#76539b"/></linearGradient></defs><circle class="mb-progress-track" cx="12" cy="12" r="9"/><circle class="mb-progress-value" cx="12" cy="12" r="9" stroke="url(#${progressGradientId})"/></svg></span><span class="mb-translation-status" aria-live="polite">Prompt ready</span></div>
          <div class="mb-field-head"><label title="Describe the complete image: scene, composition, lighting, style, and visual relationships.">Summary <span class="mb-info" tabindex="0" data-help="Describe the whole image in natural language: scene, composition, lighting, style, and how the elements relate. Keep box-specific appearance in each box description.">i</span></label><div class="mb-field-actions"><button class="mb-translate-field" data-translate-target="summary" type="button" aria-label="Translate summary" title="Translate only the summary field">${TRANSLATE_ICON}</button><button class="mb-enhance-field" data-enhance-target="summary" type="button" title="Generate improved text for only the summary field">Generate</button></div></div>
          <textarea class="mb-summary" placeholder="Describe the whole image: scene, composition, lighting, and style…" title="Global description of the whole image"></textarea>
          <div class="mb-field-head"><label title="Optional comma-separated medium or genre tags supported by MOSS-Image.">Summary metadata <span class="mb-info" tabindex="0" data-help="Optional MOSS-Image summary tags such as 'editorial photography, product campaign'. This becomes summary.meta in the JSON. Leave blank if you do not need tags.">i</span></label><div class="mb-field-actions"><button class="mb-translate-field" data-translate-target="meta" type="button" aria-label="Translate summary metadata" title="Translate summary metadata">${TRANSLATE_ICON}</button><button class="mb-enhance-field" data-enhance-target="meta" type="button" title="Generate improved tags for only the summary metadata">Generate</button></div></div>
          <textarea class="mb-meta" placeholder="Optional tags, e.g. editorial photography, product campaign" title="Optional medium or genre tags, separated by commas"></textarea>
          <label title="Optional MOSS summary.canvas hint. It is not required; it can suggest a single image, multi-panel layout, or collage.">Composition layout</label>
          <select class="mb-canvas-type" title="Optional MOSS summary.canvas hint; leave unspecified unless the composition structure matters"><option value="">Not specified</option><option value="single">Single image</option><option value="multi_panel">Multi-panel</option><option value="collage">Collage</option></select>
          <label title="Optional whole-image palette sent as summary.palette.">Summary palette</label><div class="mb-global-palette"></div><div class="mb-palette-tools"><button class="mb-add-summary-color" type="button" title="Add a color to the whole-image palette">＋ Add color</button><button class="mb-pick-summary" type="button" title="Sample a color from the preview">⌖ Sample</button></div><label title="Items are sent to MOSS in this order. Add broad background regions first and foreground details last.">Elements</label><div class="mb-elements" aria-label="Layout elements"></div><div class="mb-preview-note" aria-live="polite">Waiting for a decoded image preview</div>
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
      .mb-modal-shade{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.52);display:grid;place-items:center}.mb-modal{position:relative;width:min(420px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;background:#14191b;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 14px 44px #0009;padding:14px;color:#d3d8da;font:12px/1.45 "Segoe UI",system-ui,sans-serif}.mb-modal h3{margin:0 30px 9px 0;font-size:14px;font-weight:600}.mb-modal label{display:block;color:#b5bec1;margin:10px 0 4px}.mb-modal select,.mb-modal input,.mb-modal textarea{width:100%;background:#1b2022;color:#d3d8da;border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:7px;font:inherit}.mb-modal textarea{min-height:70px;resize:vertical}.mb-modal .mb-exact{min-height:56px}.mb-modal .mb-modal-help{color:#8e999c;font-size:10px;margin-top:4px}.mb-modal .mb-modal-buttons{display:flex;justify-content:space-between;gap:7px;margin-top:13px}.mb-modal button{background:#202629;color:#cbd4d7;border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer}.mb-modal button.primary{background:linear-gradient(#b2c0c4,#7e9096);color:#111719;border:0;font-weight:600}.mb-modal button.danger{color:#df9696}.mb-modal .mb-modal-close{position:absolute;right:8px;top:7px;width:23px;height:23px;padding:0;display:grid;place-items:center;font-size:19px;line-height:1;background:#242a2c;border:1px solid var(--line);border-radius:5px}.mb-modal .mb-field-actions .mb-enhance-field,.mb-modal .mb-field-actions .mb-enhancer-settings{width:auto;padding:3px 6px;font-size:10px}.mb-modal .mb-field-actions .mb-enhancer-settings{width:24px;padding:3px}.mb-modal .mb-field-actions .mb-translate-field{width:22px;height:22px;padding:0;font-size:15px}
      .mb-translation-modal .mb-translation-advanced{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)}.mb-translation-modal .mb-translation-advanced>summary{color:#b5bec1;cursor:pointer}.mb-translation-modal .mb-translation-advanced label:has(.mb-keep-loaded){display:flex;align-items:center;gap:8px}.mb-translation-modal .mb-keep-loaded{width:auto;margin:0}.mb-translation-modal .mb-translation-message{margin-top:10px;color:#8e999c;font-size:10px}
      .mb-help-pop{position:fixed;z-index:100000;max-width:260px;padding:8px 10px;background:#252b2f;border:1px solid rgba(255,255,255,.13);border-radius:7px;color:#d3d8da;font:11px/1.45 "Segoe UI",system-ui,sans-serif;box-shadow:0 6px 20px #0008;pointer-events:none}
      .mb-prompt{max-height:460px;overflow:auto;padding-right:3px}.mb-palette-tools{display:flex;align-items:center;gap:6px}.mb-palette-tools button{background:#1d2325;color:#cbd4d7;border:1px solid var(--line);border-radius:6px;padding:5px 8px;cursor:pointer;font:inherit}.mb-palette-list{display:flex;flex-wrap:wrap;gap:4px}.mb-color-chip{display:inline-flex;align-items:center;gap:3px}.mb-color-chip input[type=color]{padding:2px;width:22px;height:20px;cursor:pointer}.mb-color-chip button{border:0;background:transparent;color:#b5bec1;cursor:pointer;padding:0 3px}.mb-elements{display:flex;flex-direction:column;gap:4px;max-height:120px;overflow:auto}.mb-element{border:1px solid var(--line);background:#1d2325;color:#cbd4d7;border-radius:5px;padding:5px 7px;text-align:left;cursor:pointer;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mb-element.selected{border-color:var(--accent);color:#fff}
      .mb-color-popover{position:fixed;z-index:100001;width:250px;padding:12px;background:#171d1f;border:1px solid rgba(255,255,255,.18);border-radius:8px;box-shadow:0 8px 28px #000a;color:#d4dadd;font:12px/1.4 "Segoe UI",system-ui,sans-serif;display:grid;grid-template-columns:1fr;gap:8px;align-items:center}.mb-color-popover label{margin:0;color:#b5bec1;padding-right:24px}.mb-picker-plane{position:relative;width:100%;height:118px;border:1px solid #ffffff35;border-radius:5px;background-image:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent);cursor:crosshair;touch-action:none}.mb-picker-handle{position:absolute;width:12px;height:12px;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px #000;transform:translate(-50%,-50%);pointer-events:none}.mb-picker-hue-row{display:flex;align-items:center;gap:8px;color:#aeb8bb;font-size:10px}.mb-picker-hue{width:100%;height:13px;margin:0;padding:0!important;appearance:none;border:0!important;border-radius:8px;background:linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)!important}.mb-picker-hue::-webkit-slider-thumb{appearance:none;width:13px;height:13px;border:2px solid #fff;border-radius:50%;background:#272c2e}.mb-picker-value-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:7px;align-items:center}.mb-picker-preview{width:24px;height:24px;border:1px solid #ffffff50;border-radius:5px}.mb-color-popover .mb-picker-hex{width:100%;height:30px;padding:5px 7px;background:#202629;border:1px solid var(--line);border-radius:5px;color:#e2e8e9;font:11px monospace}.mb-color-popover button{background:#252c2e;color:#d1d7d9;border:1px solid var(--line);border-radius:5px;padding:5px 8px;cursor:pointer;font:inherit}.mb-color-popover .mb-pop-close{position:absolute;right:5px;top:5px;width:20px;height:20px;padding:0;font-size:17px;line-height:1}.mb-recent-colors{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:4px}.mb-color-popover .mb-recent-swatch{width:100%;height:18px;min-width:0;padding:0;border-radius:4px;border:1px solid #ffffff45}.mb-color-popover .mb-recent-swatch.is-empty{background:#242a2c;opacity:.4;cursor:default}.mb-elements{display:flex;flex-direction:column;gap:4px;max-height:120px;overflow:auto}.mb-element{border:1px solid var(--line);background:#1d2325;color:#cbd4d7;border-radius:5px;padding:5px 7px;text-align:left;cursor:pointer;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mb-element.selected{border-color:var(--accent);color:#fff}
      @media(max-width:570px){.mb-main{grid-template-columns:minmax(0,1fr)}.mb-canvas-wrap{min-height:230px}.mb-prompt{min-height:210px}.mb-summary{min-height:90px}}
      /* Keep the editor inside the resizable node in both Legacy and Node 2.0. */
      .moss-board{height:100%;min-height:0;overflow:hidden}
      .mb-head,.mb-size-row{flex:0 0 auto}
      .mb-main{grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1 1 0;min-height:0;align-items:stretch;overflow:hidden}
      .mb-canvas-wrap{display:block;height:100%;min-height:0;aspect-ratio:auto;align-self:stretch}
      .mb-canvas{position:absolute;inset:0;margin:auto;width:auto;height:auto;max-width:100%;max-height:100%;aspect-ratio:1/1;object-fit:fill}
      .mb-prompt{height:100%;max-height:none;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;align-self:stretch;scrollbar-gutter:stable}
      .mb-summary{flex:0 0 250px;min-height:90px}
      .mb-edit-targets{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:8px}
      .mb-edit-targets>label{margin:0}
      .mb-edit-picked{display:flex;flex-wrap:wrap;gap:5px;max-height:100px;overflow-y:auto}
      .mb-edit-picked:empty,.mb-edit-targets select[hidden]{display:none}
      .mb-edit-picked button{margin:0}
      .mb-edit-system{margin-top:9px;border-top:1px solid rgba(255,255,255,.08);padding-top:7px}
      .mb-edit-system>summary{color:#b5bec1;cursor:pointer}
      .mb-edit-system textarea{display:block;margin:6px 0;min-height:155px}
      .mb-edit-modes,.mb-geometry-selection{display:flex;align-items:center;gap:6px}
      .mb-edit-modes{margin-bottom:9px}
      .mb-edit-modes button[aria-pressed="true"]{background:#354043;color:#edf1f2}
      .mb-geometry-list{display:grid;gap:3px;max-height:170px;overflow-y:auto;margin-top:6px}
      .mb-modal label.mb-geometry-choice{display:flex;align-items:center;gap:7px;margin:3px 0}
      .mb-geometry-choice input[type="checkbox"]{width:auto;margin:0;flex:none}
      .mb-geometry-choice span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mb-field-prompt-buttons{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0 10px}
      .mb-field-prompt-buttons button.is-custom{border-color:var(--accent,#9eafb4)}
      .mb-field-prompt-modal textarea{min-height:140px}
      .mb-meta{min-height:48px}
      .mb-preview-note{margin-top:4px}
      .mb-translation-row{display:flex;align-items:center;gap:5px;flex:0 0 auto;margin:2px 0}.mb-translation-row button{background:#1d2325;color:#cbd4d7;border:1px solid var(--line);border-radius:5px;padding:4px 7px;cursor:pointer;font:inherit}.mb-translation-row button:hover:not(:disabled){border-color:rgba(158,175,180,.55);color:#fff}.mb-translation-row button:disabled{opacity:.45;cursor:default}.mb-translation-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:10px}.mb-enhancer-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.mb-inline-context{display:flex;align-items:center;gap:3px;flex:0 1 auto;min-width:0;color:#9ca7aa;font-size:9px;white-space:nowrap}.mb-inline-context-title{color:#9ca7aa}.mb-inline-context-value{min-width:32px;color:#d3d8da}.mb-enhancer-row input.mb-context-slider{width:64px;height:14px;margin:0;padding:0;accent-color:#9f456e;cursor:pointer}
      .mb-enhancer-progress{display:none;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px}.mb-enhancer-progress.is-active{display:inline-flex}.mb-enhancer-progress svg{display:block;width:16px;height:16px;overflow:visible}.mb-progress-track{fill:none;stroke:rgba(255,255,255,.12);stroke-width:2.2}.mb-progress-value{fill:none;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:56.55;stroke-dashoffset:56.55;transform:rotate(-90deg);transform-origin:12px 12px;transition:stroke-dashoffset .14s linear}
      .mb-field-head{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}.mb-field-head>label{margin:0}.mb-field-actions{display:flex;align-items:center;gap:3px;flex:0 0 auto}.moss-board .mb-enhance-field{flex:0 0 auto;padding:2px 6px;background:#1d2325;color:#bfcacd;border:1px solid var(--line);border-radius:4px;font:inherit;font-size:10px;line-height:1.4;cursor:pointer}.moss-board .mb-enhance-field:hover:not(:disabled){color:#fff;border-color:rgba(158,175,180,.6)}.moss-board .mb-enhance-field:disabled{opacity:.45;cursor:wait}.moss-board .mb-translate-field{display:inline-grid;place-items:center;flex:0 0 22px;width:22px;height:22px;padding:0;background:#1d2325;color:#bfcacd;border:1px solid var(--line);border-radius:4px;font:15px/1 "Segoe UI Symbol","Segoe UI",sans-serif;cursor:pointer}.moss-board .mb-translate-field:hover:not(:disabled){color:#fff;border-color:rgba(158,175,180,.6)}.moss-board .mb-translate-field:disabled{opacity:.45;cursor:wait}.mb-enhancer-modal{width:min(500px,calc(100vw - 28px))}.mb-enhancer-modal .mb-enhancer-advanced{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)}.mb-enhancer-modal .mb-enhancer-advanced>summary{color:#b5bec1;cursor:pointer}.mb-enhancer-modal .mb-enhancer-message{margin-top:8px;color:#8e999c;font-size:10px}.mb-enhancer-modal .mb-enhancer-prompt{min-height:110px}.mb-enhancer-modal .mb-enhancer-check{display:flex;align-items:center;gap:8px}.mb-enhancer-modal .mb-enhancer-check input{width:auto;margin:0}.mb-translate-icon{display:block;width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round}.mb-translate-icon text{fill:currentColor;stroke:none;font:700 5.5px/1 "Segoe UI",sans-serif}
      .mb-advanced{flex:0 0 auto;margin-top:4px}
      .mb-elements{flex:0 0 auto;min-height:0;max-height:130px;overflow-y:auto;overflow-x:hidden}
      .mb-element{flex:0 0 30px;height:30px;min-height:30px;line-height:18px;white-space:nowrap}
      @media(max-width:570px){.mb-main{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}.mb-canvas-wrap{min-height:0}.mb-prompt{min-height:0}.mb-summary{min-height:54px}}
    `;
    root.append(css);
    let domWidget = null;
    const getBoardSize = () => {
      const nodeWidth = Number(node.size?.[0]) || 580;
      const nodeHeight = Number(node.size?.[1]) || 580;
      const widgetY = Number(domWidget?.y);
      const remainingNodeHeight = widgetY > 0 ? nodeHeight - widgetY : nodeHeight;
      const allocatedHeight = Number(domWidget?.computedHeight);
      const parentHeight = Number(root.parentElement?.getBoundingClientRect?.().height);
      const elementHeight = Number(root.getBoundingClientRect?.().height);
      const measuredHeight = allocatedHeight > 0 ? allocatedHeight : parentHeight > 0 ? parentHeight : elementHeight > 0 ? elementHeight : remainingNodeHeight;
      return [Math.max(220, nodeWidth - 18), Math.max(0, Math.min(measuredHeight, remainingNodeHeight) - 20)];
    };
    let resizeFrame = 0;
    const syncBoardSize = () => {
      const [width, height] = getBoardSize();
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
      node.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
    };
    const scheduleBoardSizeSync = () => {
      syncBoardSize();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        syncBoardSize();
        // Repaint against the new canvas bounds during the resize itself. Without
        // this, the browser stretches the previous bitmap until the next edit.
        draw();
        const board = root.querySelector(".mb-canvas");
        const rect = board?.getBoundingClientRect();
        if (rect?.width > 0 && rect?.height > 0) {
          try {
            const saved = JSON.parse(getValue(node, "editor_state", "{}") || "{}");
            saved.coordinateSpace = "workspace";
            saved.workspaceAspect = 1;
            const value = JSON.stringify(saved);
            setValue(node, "editor_state", value);
            const advanced = root.querySelector(".mb-state");
            if (advanced) advanced.value = value;
          } catch {}
        }
      });
    };
    domWidget = node.addDOMWidget(WIDGET, "MOSS_LAYOUT_EDITOR", root, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => 180,
      getHeight: () => "100%",
      afterResize: scheduleBoardSizeSync,
    });
    // Keep a small Legacy minimum, but let LiteGraph allocate the widget's actual
    // height from the node's remaining body space. A computeSize override makes
    // the DOM widget a fixed-height row and lets the editor spill below the node.
    syncBoardSize();

    const $ = (selector) => root.querySelector(selector);
    const canvas = $(".mb-canvas"), ctx = canvas.getContext("2d");
    canvas.title = "Drag to draw a box. Click to select it. Hold Alt and click to cycle through overlapping boxes. Double-click to edit.";
    const ratioSelect = $(".mb-ratio"), wInput = $(".mb-width"), hInput = $(".mb-height");
    const mpSelect = $(".mb-mp-select"), mpInput = $(".mb-mp"), summary = $(".mb-summary"), meta = $(".mb-meta"), canvasType = $(".mb-canvas-type");
    const opacitySlider = $(".mb-bg-opacity"), opacityLabel = $(".mb-bg-opacity-label"), eyeButton = $(".mb-bg-eye");
    const contextSlider = $(".mb-context-slider"), contextValue = $(".mb-inline-context-value");
    const savedState = $(".mb-state"), stateToggle = $(".mb-state-toggle"), emptyHint = $(".mb-empty");
    let state = readState(node), selected = -1, gesture = null, latestPreview = null, showHelp = null, sampleMode = null, previewRect = null;
    delete state.autoTranslate;
    delete state.mossQueuedAction;
    let sourceSummary = getValue(node, "summary", ""), sourceMeta = getValue(node, "summary_meta", "");
    const pendingActions = new Set();
    let lastAction = Promise.resolve(), runningAction, openBoxTextEditor;
    const defaultActionPrompts = {};
    let activeOperationStatus = "";
    let enhancerProgressHideTimer = null;
    let landscapeOrientation = state.orientation ? state.orientation === "landscape" : Boolean(getValue(node, "portrait", false));
    const boxUiColors = new WeakMap();
    let altPickCycle = null;
    let backgroundPinned = false, previewSerial = 0, previewBlobUrl = null, lastAutoPreview = null;
    let summaryPalette = Array.isArray(state.summaryPalette) ? state.summaryPalette : [];
    let recentColors = Array.isArray(state.recentColors) ? state.recentColors.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 10) : [];
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
      const ratio = parseFloat(m[1]) / parseFloat(m[2]);
      return landscapeOrientation && ratio < 1 ? 1 / ratio : ratio;
    }
    function roundDimension(value, roundDown = false) {
      const quantum = 16, units = Number(value) / quantum;
      return Math.max(64, (roundDown ? Math.floor(units) : Math.floor(units + .5)) * quantum);
    }
    function fitDimensions(ratio, megapixels, roundDown = false) {
      const quantum = 16, area = Math.max(4096, Number(megapixels) * 1e6), r = Math.max(1e-9, Number(ratio));
      const idealWidth = Math.sqrt(area * r), idealHeight = Math.sqrt(area / r);
      const centerWidth = idealWidth / quantum, centerHeight = idealHeight / quantum, maxUnits = 65536 / quantum;
      const firstWidth = Math.max(4, Math.floor(centerWidth) - 8), lastWidth = Math.min(maxUnits, Math.ceil(centerWidth) + 8);
      let best = null;
      for (let widthUnit = firstWidth; widthUnit <= lastWidth; widthUnit++) {
        const width = widthUnit * quantum, heightUnits = new Set();
        for (const center of [widthUnit / r, area / (quantum * quantum * widthUnit), centerHeight]) {
          const firstHeight = Math.max(4, Math.floor(center) - 3), lastHeight = Math.min(maxUnits, Math.ceil(center) + 3);
          for (let heightUnit = firstHeight; heightUnit <= lastHeight; heightUnit++) heightUnits.add(heightUnit);
        }
        for (const heightUnit of heightUnits) {
          const height = heightUnit * quantum, candidateArea = width * height;
          if (roundDown && candidateArea > area) continue;
          const ratioError = Math.abs((width / height) / r - 1), areaError = Math.abs(candidateArea / area - 1);
          const candidate = { score: areaError + 2 * ratioError, ratioError, areaError, area: candidateArea, width, height };
          if (!best || candidate.score < best.score ||
            (candidate.score === best.score && (candidate.ratioError < best.ratioError ||
              (candidate.ratioError === best.ratioError && candidate.areaError < best.areaError)))) best = candidate;
        }
      }
      if (best) return [best.width, best.height];
      return [roundDimension(idealWidth, true), roundDimension(idealHeight, true)];
    }
    function calculatedSize() {
      const r = ratioSelect.value === "Custom"
        ? (Number(wInput.value) || 1024) / Math.max(1, Number(hInput.value) || 1024)
        : ratioValue();
      const mp = mpSelect.value === "Custom" ? Math.max(.25, Number(mpInput.value) || 1) : parseFloat(mpSelect.value);
      const fitImageMegapixels = linkedInput(node, "background_resize");
      return fitDimensions(r, mp, fitImageMegapixels);
    }
    function sourceMetaParts(value = sourceMeta) { return String(value || "").split(",").map((part) => part.trim()).filter(Boolean); }
    function showReplacedText(field, value) {
      field.value = value;
      field.setSelectionRange(0, 0);
      field.scrollTop = 0;
    }
    function fieldDisplayLabel(field) {
      if (field?.id === "summary.caption") return "Summary";
      if (field?.id === "summary.meta" || field?.id?.startsWith("summary.meta.")) return "Summary metadata";
      const match = /^item\.(\d+)\.(caption|text|tags)(?:\.\d+)?$/.exec(String(field?.id || ""));
      if (!match) return String(field?.type || "Text field");
      const index = Number(match[1]);
      const kind = TYPE_NAME[state.items[index]?.label] || "Object";
      const detail = { caption: "description", text: "exact visible text", tags: "tags" }[match[2]];
      return `${kind} ${index + 1} · ${detail}`;
    }
    function gatherTranslationFields() {
      const fields = [];
      if (String(summary.value || "").trim()) fields.push({ id: "summary.caption", text: String(summary.value).trim(), current: () => summary.value, apply: (value) => showReplacedText(summary, value) });
      sourceMetaParts(meta.value).forEach((text, index) => fields.push({
        id: `summary.meta.${index}`, text,
        current: () => sourceMetaParts(meta.value)[index] ?? null,
        apply: (value) => { const parts = sourceMetaParts(meta.value); if (index < parts.length) { parts[index] = value; meta.value = parts.join(", "); } },
      }));
      state.items.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        for (const field of ["caption", "text"]) if (typeof item[field] === "string" && item[field].trim()) fields.push({
          id: `item.${index}.${field}`, text: field === "caption" ? item[field].trim() : item[field],
          current: () => state.items.includes(item) ? item[field] ?? null : null,
          apply: (value) => { if (state.items.includes(item)) { if (field === "text" && !value.trim()) delete item.text; else item[field] = value; } },
        });
        (Array.isArray(item.tags) ? item.tags : []).forEach((text, tagIndex) => {
          if (typeof text !== "string" || !text.trim()) return;
          fields.push({ id: `item.${index}.tags.${tagIndex}`, text, current: () => state.items.includes(item) ? item.tags?.[tagIndex] ?? null : null, apply: (value) => { if (state.items.includes(item) && Array.isArray(item.tags) && tagIndex < item.tags.length) item.tags[tagIndex] = value; } });
        });
      });
      return fields;
    }
    function translationSettings(settings = {}) {
      return {
        source_language: settings.source_language || "Auto Detect",
        target_language: settings.target_language || "English",
        model_size: settings.model_size || "4B",
        device: settings.device || "default",
        prompt_mode: settings.prompt_mode || "auto",
        max_new_tokens: Math.trunc(Math.max(0, Math.min(8192, Number(settings.max_new_tokens) || 0))),
        max_input_tokens: Math.trunc(Math.max(0, Math.min(8192, Number(settings.max_input_tokens) || 0))),
        quantization: ["none", "bnb-8bit", "bnb-4bit"].includes(settings.quantization) ? settings.quantization : "none",
        keep_model_loaded: settings.keep_model_loaded !== false,
      };
    }
    function enhancerSettings(settings = {}) {
      const numberOr = (key, fallback) => settings[key] !== undefined && settings[key] !== "" && Number.isFinite(Number(settings[key])) ? Number(settings[key]) : fallback;
      const reasoningEffort = ["off", "low", "medium", "high"].includes(settings.reasoning_effort)
        ? settings.reasoning_effort : settings.thinking === true ? "medium" : "off";
      return {
        max_length: Math.trunc(Math.max(16, Math.min(32768, numberOr("max_length", 1024)))),
        thinking: reasoningEffort !== "off",
        reasoning_effort: reasoningEffort,
        use_default_template: settings.use_default_template !== false,
        use_jinja_template: (settings.use_jinja_template ?? settings.use_default_template) !== false,
        temperature: Math.max(0.01, Math.min(2, numberOr("temperature", 0.7))),
        top_k: Math.trunc(Math.max(0, Math.min(1000, numberOr("top_k", 20)))),
        top_p: Math.max(0, Math.min(1, numberOr("top_p", 0.8))),
        min_p: Math.max(0, Math.min(1, numberOr("min_p", 0))),
        repetition_penalty: Math.max(0, Math.min(5, numberOr("repetition_penalty", 1))),
        presence_penalty: Math.max(0, Math.min(5, numberOr("presence_penalty", 0))),
        seed: Math.trunc(Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, numberOr("seed", 0)))),
        sampling_mode: settings.sampling_mode === "off" ? "off" : "on",
        mtp: settings.mtp || "auto",
        system_prompt: String(settings.system_prompt || ""),
        edit_system_prompt: typeof settings.edit_system_prompt === "string" ? settings.edit_system_prompt.trim() : "",
        geometry_system_prompt: typeof settings.geometry_system_prompt === "string" ? settings.geometry_system_prompt.trim() : "",
        field_prompts: Object.fromEntries(Object.keys(FIELD_PROMPT_LABELS)
          .filter((key) => typeof settings.field_prompts?.[key] === "string" && settings.field_prompts[key].trim())
          .map((key) => [key, settings.field_prompts[key].trim()])),
        context_mode: ["none", "summary", "full"].includes(settings.context_mode) ? settings.context_mode : "full",
      };
    }
    function updateContextControl() {
      const mode = enhancerSettings(state.promptEnhancerSettings || {}).context_mode;
      const index = Math.max(0, CONTEXT_MODES.indexOf(mode));
      if (contextSlider) contextSlider.value = String(index);
      if (contextValue) contextValue.textContent = CONTEXT_LABELS[index] || "Full";
      if (contextSlider) contextSlider.title = `${CONTEXT_LABELS[index]} context: ${["only the target field", "the global summary and metadata", "the summary and all box fields and coordinates"][index]}`;
    }
    function enhancerUrl(path) {
      const route = `/moss_layout_ydr/prompt-enhancer/${path}`;
      return typeof app.api?.apiURL === "function" ? app.api.apiURL(route) : route;
    }
    async function runTextAction(kind, payload, fields, verb, { apply, onQueued, onError, watch = fields } = {}) {
      const labels = fields.map(fieldDisplayLabel);
      const labelsById = new Map(fields.map((field, index) => [field.id, labels[index]]));
      const snapshots = watch.map((field) => ({ field, expected: field.current() }));
      const action = { status: `${verb} · submitting…`, progress: 0, snapshots };
      const previous = lastAction;
      let complete;
      lastAction = new Promise((resolve) => { complete = resolve; });
      pendingActions.add(action);
      if (pendingActions.size === 1) startEnhancerProgress();
      refreshTranslationStatus();
      try {
        const result = await queueTextAction(app, node, kind, payload, {
          onQueued: () => {
            action.status = `${verb} · waiting in the ComfyUI queue…`;
            refreshTranslationStatus();
            onQueued?.();
          },
          onProgress: (event) => {
            const fraction = event.finished ? 1 : event.token_limit
              ? Math.min(0.99, event.tokens / event.token_limit) : 0;
            const ratio = event.max > 0 ? event.value / event.max : (event.index - 1 + fraction) / event.total;
            const tokenStatus = event.token_limit ? ` · ${event.tokens}/${event.token_limit} tokens` : "";
            const fieldLabel = `${verb} ${labelsById.get(event.field_id) ?? labels[event.index - 1] ?? "text field"}`;
            action.progress = 100 * ratio;
            runningAction = action;
            action.status = `${fieldLabel} · ${event.index}/${event.total}${tokenStatus}`;
            refreshTranslationStatus();
            return fieldLabel;
          },
        });
        await previous;
        // Pending jobs keep their original model inputs. Accept earlier queue changes
        // as the current value only where the user has not edited the field meanwhile.
        const following = Array.from(pendingActions).filter((job) => job !== action)
          .flatMap((job) => job.snapshots)
          .filter(({ field, expected }) => field.current() === expected);
        activeOperationStatus = apply(result, snapshots);
        for (const entry of following) entry.expected = entry.field.current();
      } catch (error) {
        await previous;
        activeOperationStatus = error?.message || String(error);
        onError?.(activeOperationStatus);
      } finally {
        pendingActions.delete(action);
        if (runningAction === action) runningAction = undefined;
        if (!pendingActions.size) finishEnhancerProgress(action.progress >= 100);
        refreshTranslationStatus();
        complete();
      }
    }
    function applyActionValues(snapshots, result) {
      let applied = 0, skipped = 0;
      const editor = openBoxTextEditor;
      const before = editor?.readSaved();
      for (const { field, expected } of snapshots) {
        const value = result.values[field.id];
        if (typeof value !== "string" || !value.trim() || value === field.text) continue;
        const current = field.current();
        if (current === value) continue;
        if (current == null || current !== expected) { skipped++; continue; }
        field.apply(value);
        applied++;
      }
      if (applied) editor?.refresh(before);
      // Keep the edits when the same connected layout is used on the next workflow run.
      if (applied > 0 && linkedInput(node, "layout_text") && state.lastLayoutInputHash) {
        state.suppressLayoutInput = true;
        state.suppressLayoutHash = state.lastLayoutInputHash;
      }
      return { applied, skipped };
    }
    function clipSocketConnected() {
      return (node.inputs || []).some((input) => input.name === "clip" && input.link != null);
    }
    function enhancerOptionsUrl() {
      return `${enhancerUrl("options")}?node_id=${encodeURIComponent(node.id)}`;
    }
    function setEnhancerProgress(value) {
      const progress = $(".mb-enhancer-progress");
      const percent = Math.min(100, Math.max(0, value));
      const circle = progress?.querySelector(".mb-progress-value");
      if (circle) circle.style.strokeDashoffset = String(56.55 * (1 - percent / 100));
      progress?.setAttribute("aria-valuenow", String(Math.round(percent)));
    }
    function startEnhancerProgress() {
      clearTimeout(enhancerProgressHideTimer);
      setEnhancerProgress(0);
      $(".mb-enhancer-progress")?.classList.add("is-active");
    }
    function finishEnhancerProgress(success) {
      if (success) setEnhancerProgress(100);
      enhancerProgressHideTimer = setTimeout(() => {
        $(".mb-enhancer-progress")?.classList.remove("is-active");
      }, 220);
    }
    function gatherEnhanceAllFields() {
      const fields = [];
      const add = (id, type, text, current, apply) => {
        if (typeof text === "string" && text.trim()) fields.push({ id, type, text, current, apply });
      };
      add("summary.caption", "whole-image summary", summary.value, () => summary.value, (value) => showReplacedText(summary, value));
      add("summary.meta", "summary metadata tags", meta.value, () => meta.value, (value) => { meta.value = value; });
      state.items.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        for (const field of ["caption", "text"]) {
          add(`item.${index}.${field}`, field === "caption" ? `${TYPE_NAME[item.label] || "Object"} description` : "exact visible text", item[field], () => state.items.includes(item) ? item[field] ?? null : null, (value) => { if (state.items.includes(item)) item[field] = value; });
        }
        if (Array.isArray(item.tags)) {
          const tags = item.tags.join(", ");
          add(`item.${index}.tags`, "box tags", tags, () => state.items.includes(item) && Array.isArray(item.tags) ? item.tags.join(", ") : null, (value) => { if (state.items.includes(item)) item.tags = value.split(",").map((tag) => tag.trim()).filter(Boolean); });
        }
      });
      return fields;
    }
    function buildEnhancementContext() {
      const [width, height] = calculatedSize();
      const items = state.items.map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const bbox = Array.isArray(item.bbox) && item.bbox.length === 4
          ? item.bbox.map((value) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(5)) : 0)
          : [0, 0, 1, 1];
        const contextItem = {
          id: `item.${index}`,
          label: TYPE_NAME[item.label] || "Object",
          bbox,
        };
        for (const key of ["caption", "text"]) if (typeof item[key] === "string" && item[key].trim()) contextItem[key] = item[key];
        if (Array.isArray(item.tags) && item.tags.length) contextItem.tags = item.tags.filter((tag) => typeof tag === "string" && tag.trim());
        if (Array.isArray(item.palette) && item.palette.length) contextItem.palette = item.palette;
        return contextItem;
      }).filter(Boolean);
      return {
        target_size_px: { width, height },
        workspace: { size: [CW, CH], bbox_format: "xyxy", coordinate_space: "normalized 0–1 relative to the fixed working field" },
        summary: {
          caption: String(summary.value || "").trim(),
          meta: sourceMetaParts(meta.value),
          canvas: canvasType.value || "not specified",
          palette: summaryPalette,
        },
        items,
      };
    }
    function enhanceFields(fields, options = {}) {
      fields = fields.filter((field) => typeof field?.text === "string" && field.text.trim());
      if (!fields.length) { $(".mb-translation-status").textContent = "Add text to a field before generating"; return; }
      const settings = enhancerSettings(state.promptEnhancerSettings || {});
      state.promptEnhancerSettings = settings;
      syncWidgets();
      const actionVerb = options.editInstruction ? "Editing" : "Generating";
      return runTextAction(options.editInstruction ? "edit" : "generate", {
        segments: fields.map((field) => ({ id: field.id, type: fieldDisplayLabel(field), text: field.text })),
        context: buildEnhancementContext(),
        settings,
        ...(options.editInstruction ? { edit_instruction: options.editInstruction } : {}),
      }, fields, actionVerb, {
        onQueued: options.onQueued,
        onError: options.onError,
        apply: (result, snapshots) => {
          const { applied, skipped } = applyActionValues(snapshots, result);
          const emptyFields = result.empty_fields?.length ?? 0;
          if (applied) saveState();
          let status = applied
            ? `${options.editInstruction ? "Edited" : "Updated"} ${applied} field${applied === 1 ? "" : "s"}`
            : options.editInstruction && !skipped ? "The model returned the original text" : "No fields changed";
          if (skipped) status += ` · ${skipped} changed after submission`;
          if (emptyFields) status += ` · ${emptyFields} field${emptyFields === 1 ? "" : "s"} returned no text`;
          options.onResult?.(status);
          return status;
        },
      });
    }
    function parseEditTerms(value) {
      return [...new Set(String(value || "").split(/[,;\n]+/).map((term) => term.trim()).filter(Boolean))];
    }
    function matchingEditTargets(terms) {
      if (!terms.length) return { boxIndices: [], summary: false, metadata: false };
      const patterns = terms.map((term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu");
      });
      const matches = (value) => typeof value === "string" && patterns.some((pattern) => pattern.test(value));
      const boxIndices = state.items.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const searchable = [item.label, item.caption, item.text, ...(Array.isArray(item.tags) ? item.tags : [])].filter((value) => typeof value === "string").join(" ");
        return matches(searchable) ? [index] : [];
      });
      return { boxIndices, summary: matches(summary.value), metadata: matches(meta.value) };
    }
    function editFieldGroups() {
      const groups = new Map();
      for (const field of gatherEnhanceAllFields()) {
        const box = /^item\.(\d+)\./.exec(field.id);
        const index = box ? Number(box[1]) : -1;
        const item = index >= 0 ? state.items[index] : null;
        const key = item ?? field.id;
        if (!groups.has(key)) {
          const label = item ? `${TYPE_NAME[item.label] || "Object"} ${index + 1}` : fieldDisplayLabel(field);
          groups.set(key, { key, label, fields: [] });
        }
        groups.get(key).fields.push(field);
      }
      return [...groups.values()];
    }
    function resolveEditSelection(groups, terms, manualFields) {
      if (!terms.length && !manualFields.size) return { groups, all: true };
      const matched = matchingEditTargets(terms);
      const selected = new Set(manualFields.keys());
      if (matched.summary) selected.add("summary.caption");
      if (matched.metadata) selected.add("summary.meta");
      for (const index of matched.boxIndices) selected.add(state.items[index]);
      return { groups: groups.filter((group) => selected.has(group.key)), all: false };
    }
    function actionPromptMarkup(title, help) {
      return `<details class="mb-edit-system">
        <summary>${title}</summary>
        <div class="mb-modal-help">${help} Changes are saved with this workflow.</div>
        <textarea aria-label="${title}" maxlength="12000" placeholder="Leave blank to use the built-in instructions."></textarea>
        <button type="button">Reset to default</button>
        <div class="mb-modal-help mb-edit-system-status" aria-live="polite"></div>
      </details>`;
    }
    function bindActionPrompt(dialog, key) {
      const details = dialog.querySelector(".mb-edit-system");
      const text = details.querySelector("textarea");
      const reset = details.querySelector("button");
      const status = details.querySelector(".mb-edit-system-status");
      const stored = () => state.promptEnhancerSettings?.[key] || "";
      text.value = stored() || defaultActionPrompts[key] || "";
      const save = () => {
        const value = text.value.trim();
        state.promptEnhancerSettings = {
          ...state.promptEnhancerSettings, [key]: value === defaultActionPrompts[key] ? "" : value,
        };
        syncWidgets();
      };
      text.addEventListener("input", save);
      reset.onclick = () => {
        text.value = defaultActionPrompts[key] || "";
        save();
        text.focus();
      };
      let loading = false;
      details.addEventListener("toggle", async () => {
        if (!details.open || defaultActionPrompts[key] || loading) return;
        loading = true;
        status.textContent = "Loading built-in instructions…";
        try {
          const response = await fetch(enhancerOptionsUrl(), { credentials: "same-origin" });
          const options = await response.json();
          const value = options[`default_${key}`];
          if (!response.ok || typeof value !== "string") throw new Error("Built-in instructions unavailable.");
          defaultActionPrompts[key] = value;
          if (!stored()) text.value = value;
          status.textContent = "";
        } catch {
          status.textContent = "Could not load the built-in text. An empty field still uses it.";
        } finally {
          loading = false;
        }
      });
    }
    function openTargetedEditDialog() {
      const shade = document.createElement("div"); shade.className = "mb-modal-shade mb-edit-shade";
      const dialog = document.createElement("div"); dialog.className = "mb-modal mb-targeted-edit-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
      dialog.innerHTML = `
        <h3>Edit layout</h3>
        <div class="mb-edit-modes"><button type="button" aria-pressed="true">Prompt fields</button><button type="button" class="mb-box-geometry" aria-pressed="false">Box Geometry</button></div>
        <label for="mb-edit-terms">Words or phrases to find</label>
        <textarea id="mb-edit-terms" class="mb-edit-terms" maxlength="4000" placeholder="birds, red dress, chair"></textarea>
        <div class="mb-modal-help">Optional. Separate terms with commas, semicolons, or new lines.</div>
        <label for="mb-edit-instruction">Change Request</label>
        <textarea id="mb-edit-instruction" class="mb-edit-instruction" maxlength="12000" placeholder="Make the selected subjects look like a watercolor illustration."></textarea>
        ${actionPromptMarkup("System Prompt (Edit)", "This instruction is added after the shared System Prompt and field guidance. Edit also sends the current field, Change Request, and selected context.")}
        <div class="mb-edit-targets">
          <label>Fields to edit</label>
          <div class="mb-edit-picked"></div>
          <button type="button" class="mb-edit-add" aria-expanded="false" aria-controls="mb-edit-field-picker">+ Add Field</button>
          <select id="mb-edit-field-picker" class="mb-edit-field-picker" aria-label="Field to add" hidden></select>
        </div>
        <div class="mb-modal-help">Manual choices are added to keyword matches. Selecting a box includes all its filled text fields. Leave both selections empty to edit every filled field.</div>
        <div class="mb-modal-message mb-edit-match-count" aria-live="polite"></div>
        <div class="mb-modal-buttons"><button type="button" class="mb-edit-cancel">Cancel</button><span></span><button type="button" class="primary mb-edit-run" disabled>Edit fields</button></div>
      `;
      shade.append(dialog); document.body.append(shade);
      const closeButton = document.createElement("button"); closeButton.type = "button"; closeButton.className = "mb-modal-close"; closeButton.title = "Close"; closeButton.setAttribute("aria-label", "Close"); closeButton.textContent = "×"; dialog.insertBefore(closeButton, dialog.firstChild);
      const termsInput = dialog.querySelector(".mb-edit-terms"), instructionInput = dialog.querySelector(".mb-edit-instruction");
      const matchCount = dialog.querySelector(".mb-edit-match-count"), run = dialog.querySelector(".mb-edit-run");
      const add = dialog.querySelector(".mb-edit-add"), picker = dialog.querySelector(".mb-edit-field-picker");
      const picked = dialog.querySelector(".mb-edit-picked");
      bindActionPrompt(dialog, "edit_system_prompt");
      const manualFields = new Map();
      let available = [], running = false;
      const showPicker = (shown) => {
        picker.hidden = !shown;
        add.setAttribute("aria-expanded", String(shown));
      };
      const close = () => shade.remove();
      closeButton.onclick = dialog.querySelector(".mb-edit-cancel").onclick = close;
      dialog.querySelector(".mb-box-geometry").onclick = () => {
        if (running) return;
        close();
        openGeometryEditDialog();
      };
      shade.addEventListener("pointerdown", (event) => { if (event.target === shade) close(); });
      shade.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!picker.hidden) {
          showPicker(false);
          add.focus();
        } else close();
      });
      termsInput.value = typeof state.lastEditTerms === "string" ? state.lastEditTerms : "";
      instructionInput.value = typeof state.lastEditInstruction === "string" ? state.lastEditInstruction : "";
      const saveEditDialogState = () => {
        state.lastEditTerms = termsInput.value;
        state.lastEditInstruction = instructionInput.value;
        savedState.value = JSON.stringify(state);
        setValue(node, "editor_state", savedState.value);
      };
      const refreshSelection = () => {
        const groups = editFieldGroups();
        available = groups.filter((group) => !manualFields.has(group.key));
        picker.replaceChildren(new Option("Choose a field…", ""), ...available.map((group, index) => new Option(group.label, String(index))));
        if (!available.length) showPicker(false);
        add.disabled = running || !available.length;
        picker.disabled = running;
        termsInput.disabled = instructionInput.disabled = running;
        picked.replaceChildren();
        for (const [key, name] of manualFields) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.disabled = running;
          chip.textContent = `${name} ×`;
          chip.setAttribute("aria-label", `Remove ${name}`);
          chip.onclick = () => {
            manualFields.delete(key);
            refreshSelection();
            add.focus();
          };
          picked.append(chip);
        }
        const selection = resolveEditSelection(groups, parseEditTerms(termsInput.value), manualFields);
        const fields = selection.groups.flatMap((group) => group.fields);
        const count = `${fields.length} filled field${fields.length === 1 ? "" : "s"}`;
        if (running) matchCount.textContent = `Editing ${count}…`;
        else if (selection.all) matchCount.textContent = fields.length ? `All ${count} selected.` : "There are no filled fields to edit.";
        else if (fields.length) {
          const names = selection.groups.slice(0, 4).map((group) => group.label).join(", ");
          const remaining = selection.groups.length - 4;
          matchCount.textContent = `${count} selected · ${names}${remaining > 0 ? ` and ${remaining} more` : ""}.`;
        } else matchCount.textContent = "No filled fields match the current selection.";
        run.disabled = running || !instructionInput.value.trim() || !fields.length;
        return fields;
      };
      add.onclick = () => {
        showPicker(picker.hidden);
        if (!picker.hidden) {
          picker.focus();
          try { picker.showPicker?.(); } catch { /* The native select remains keyboard accessible. */ }
        }
      };
      picker.onchange = () => {
        if (picker.value === "") return;
        const group = available[Number(picker.value)];
        if (!group) return;
        manualFields.set(group.key, group.label);
        showPicker(false);
        refreshSelection();
        (add.disabled ? instructionInput : add).focus();
      };
      termsInput.addEventListener("input", () => { saveEditDialogState(); refreshSelection(); });
      instructionInput.addEventListener("input", () => { saveEditDialogState(); refreshSelection(); });
      let submission = 0;
      run.addEventListener("click", () => {
        if (running) return;
        const instruction = instructionInput.value.trim();
        const fields = refreshSelection();
        if (!instruction || !fields.length) return;
        running = true;
        showPicker(false);
        refreshSelection();
        const currentSubmission = ++submission;
        const showStatus = (status) => {
          if (currentSubmission !== submission) return;
          running = false;
          refreshSelection();
          matchCount.textContent = status;
        };
        enhanceFields(fields, {
          editInstruction: instruction,
          onQueued: () => showStatus("Added to the ComfyUI queue."),
          onResult: showStatus,
          onError: showStatus,
        });
      });
      refreshSelection();
      termsInput.focus();
    }
    function geometryTargets(items, width, height) {
      const frame = fieldRect();
      const clampUnit = (value) => Math.max(0, Math.min(1, value));
      return items.map((item, index) => {
        const frameBox = boxPx(item.bbox).map((value, axis) => clampUnit(axis % 2
          ? (value - frame.y) / frame.h : (value - frame.x) / frame.w));
        const bbox = frameBox.map((value) => Math.round(value * 1000));
        const pixelBox = frameBox.map((value, axis) => Math.round(value * (axis % 2 ? height : width)));
        if (!geometryBoxValid(bbox) || pixelBox[0] >= pixelBox[2] || pixelBox[1] >= pixelBox[3]) {
          throw new Error("A selected box has no usable area inside the generation frame.");
        }
        return {
          item, frameBox,
          input: {
            id: `B${index + 1}`, bbox, pixel_bbox: pixelBox,
            type: TYPE_NAME[item.label] || "Object",
            description: String(item.caption || "").slice(0, 3000),
            visible_text: String(item.text || "").slice(0, 1000),
            tags: Array.isArray(item.tags) ? item.tags.slice(0, 20).map((tag) => String(tag).slice(0, 120)) : [],
          },
        };
      });
    }
    function geometryBoxValid(box) {
      return Array.isArray(box) && box.length === 4
        && box.every((value) => Number.isInteger(value) && value >= 0 && value <= 1000)
        && box[0] < box[2] && box[1] < box[3];
    }
    function geometryReference(image, targets, frameWidth, frameHeight) {
      const reference = document.createElement("canvas");
      const resize = Math.min(1024 / frameWidth, 1024 / frameHeight);
      const width = reference.width = Math.max(1, Math.round(frameWidth * resize));
      const height = reference.height = Math.max(1, Math.round(frameHeight * resize));
      const context = reference.getContext("2d");
      const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const drawnWidth = image.naturalWidth * fit, drawnHeight = image.naturalHeight * fit;
      context.fillStyle = "#252a2c";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
      const fontSize = Math.max(12, Math.round(Math.min(width, height) * .029));
      context.font = `bold ${fontSize}px sans-serif`;
      context.textBaseline = "top";
      targets.forEach(({ input, frameBox }, index) => {
        const [left, top, right, bottom] = frameBox.map((value, axis) => value * (axis % 2 ? height : width));
        const color = `hsl(${(48 + index * 137.5) % 360} 95% 69%)`;
        const boxWidth = right - left, boxHeight = bottom - top;
        context.strokeStyle = "#181a1b";
        context.lineWidth = 5;
        context.strokeRect(left, top, boxWidth, boxHeight);
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.strokeRect(left, top, boxWidth, boxHeight);
        const labelWidth = context.measureText(input.id).width + 8;
        const labelX = Math.min(left, Math.max(0, width - labelWidth));
        const labelY = top >= fontSize + 5 ? top - fontSize - 5 : top;
        context.fillStyle = "#181a1b";
        context.fillRect(labelX, labelY, labelWidth, fontSize + 5);
        context.fillStyle = color;
        context.fillText(input.id, labelX + 4, labelY + 2);
      });
      try {
        return reference.toDataURL("image/jpeg", .84);
      } catch {
        throw new Error("The current background could not be sent to CLIP. Turn off Use current background to continue with coordinates only.");
      }
    }
    function applyGeometryResult(targets, values, snapshots) {
      const updates = [];
      for (const [index, { item, input }] of targets.entries()) {
        const { field, expected } = snapshots[index];
        if (field.current() == null || field.current() !== expected) {
          throw new Error("A selected box changed while CLIP was working. Run the edit again to use the new coordinates.");
        }
        const bbox = values[input.id];
        if (!geometryBoxValid(bbox)) throw new Error("CLIP returned invalid box coordinates.");
        if (!bbox.every((value, index) => value === input.bbox[index])) {
          updates.push({ item, bbox: generationBoxToWorkspace(bbox.map((value) => value / 1000)) });
        }
      }
      for (const { item, bbox } of updates) item.bbox = bbox;
      if (updates.length && linkedInput(node, "layout_text") && state.lastLayoutInputHash) {
        state.suppressLayoutInput = true;
        state.suppressLayoutHash = state.lastLayoutInputHash;
      }
      return updates.length;
    }
    function openGeometryEditDialog() {
      const shade = document.createElement("div");
      shade.className = "mb-modal-shade";
      const dialog = document.createElement("div");
      dialog.className = "mb-modal";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "Edit box geometry");
      dialog.innerHTML = `
        <button type="button" class="mb-modal-close" aria-label="Close">×</button>
        <h3>Edit layout</h3>
        <div class="mb-edit-modes"><button type="button" class="mb-prompt-edit" aria-pressed="false">Prompt fields</button><button type="button" aria-pressed="true">Box Geometry</button></div>
        <label>Change request<textarea class="mb-geometry-prompt" maxlength="6000" placeholder="Make the house about the size of a mouse, keeping it on the ground."></textarea></label>
        ${actionPromptMarkup("System Prompt (Box Geometry)", "These instructions guide how the model reads the selected boxes, optional reference image, and Change Request.")}
        <label>Boxes to edit</label>
        <div class="mb-geometry-selection"><button type="button" class="mb-geometry-all">Select all</button><button type="button" class="mb-geometry-none">Clear selection</button></div>
        <div class="mb-geometry-list"></div>
        <label class="mb-geometry-choice"><input class="mb-geometry-image" type="checkbox"> <span>Use current background</span></label>
        <div class="mb-modal-help">CLIP receives the full background with outlines, coordinates, and descriptions for the selected boxes. Using the background requires a vision-capable encoder.</div>
        <div class="mb-modal-message mb-geometry-message" aria-live="polite"></div>
        <div class="mb-modal-buttons"><button type="button" class="mb-geometry-cancel">Close</button><span></span><button type="button" class="primary mb-geometry-run">Adjust boxes</button></div>
      `;
      const control = (selector) => dialog.querySelector(selector);
      const prompt = control(".mb-geometry-prompt"), run = control(".mb-geometry-run");
      const useImage = control(".mb-geometry-image"), message = control(".mb-geometry-message");
      const all = control(".mb-geometry-all"), none = control(".mb-geometry-none");
      const back = control(".mb-prompt-edit"), list = control(".mb-geometry-list");
      bindActionPrompt(dialog, "geometry_system_prompt");
      const background = () => latestPreview?.complete && latestPreview.naturalWidth ? latestPreview : null;
      useImage.disabled = !background();
      useImage.checked = !useImage.disabled;
      const choices = state.items.map((item, index) => {
        const row = document.createElement("label"), check = document.createElement("input");
        const caption = document.createElement("span");
        row.className = "mb-geometry-choice";
        check.type = "checkbox";
        check.checked = !state.items[selected] || selected === index;
        caption.textContent = `${TYPE_NAME[item.label] || "Object"} ${index + 1}${item.caption ? ` · ${item.caption}` : ""}`;
        caption.title = caption.textContent;
        row.append(check, caption);
        list.append(row);
        return { item, check };
      });
      const close = () => shade.remove();
      control(".mb-modal-close").onclick = control(".mb-geometry-cancel").onclick = close;
      back.onclick = () => { close(); openTargetedEditDialog(); };
      shade.onpointerdown = (event) => { if (event.target === shade) close(); };
      shade.onkeydown = (event) => { if (event.key === "Escape") close(); };
      const picked = () => choices.filter(({ check }) => check.checked);
      let submitting = false;
      const refresh = () => {
        const count = picked().length;
        run.disabled = !prompt.value.trim() || !count || submitting;
        message.textContent = count ? `${count} box${count === 1 ? "" : "es"} selected` : "Select a box to edit.";
      };
      all.onclick = () => { choices.forEach(({ check }) => { check.checked = true; }); refresh(); };
      none.onclick = () => { choices.forEach(({ check }) => { check.checked = false; }); refresh(); };
      list.onchange = prompt.oninput = refresh;
      let submission = 0;
      run.onclick = () => {
        if (run.disabled) return;
        if (!clipSocketConnected()) {
          message.textContent = "Connect a CLIP encoder to MOSS Layout YDR.";
          return;
        }
        const width = Number(wInput.value), height = Number(hInput.value);
        const image = useImage.checked ? background() : null;
        let targets, reference;
        try {
          targets = geometryTargets(picked().map(({ item }) => item), width, height);
          if (useImage.checked && !image) throw new Error("The current background is still loading.");
          if (image) reference = geometryReference(image, targets, width, height);
        } catch (error) {
          message.textContent = error.message;
          return;
        }
        submitting = run.disabled = true;
        message.textContent = "Submitting box geometry…";
        const currentSubmission = ++submission;
        const showStatus = (status) => {
          if (currentSubmission !== submission) return;
          submitting = false;
          refresh();
          message.textContent = status;
        };
        runTextAction("geometry", {
          instruction: prompt.value.trim(), width, height, image: reference,
          boxes: targets.map(({ input }) => input),
          settings: enhancerSettings(state.promptEnhancerSettings || {}),
        }, [{
          id: "geometry",
          type: targets.length === 1
            ? `${TYPE_NAME[targets[0].item.label] || "Object"} ${state.items.indexOf(targets[0].item) + 1} geometry`
            : `geometry for ${targets.length} boxes`,
        }], "Adjusting", {
          watch: targets.map(({ item }) => ({ current: () => state.items.includes(item) ? item.bbox.join(",") : null })),
          onQueued: () => showStatus("Added to the ComfyUI queue."),
          onError: showStatus,
          apply: (result, snapshots) => {
            if (width !== Number(wInput.value) || height !== Number(hInput.value) || (image && image !== background())) {
              throw new Error("The generation frame or background changed after submission. Run the edit again.");
            }
            const changed = applyGeometryResult(targets, result.values, snapshots);
            if (changed) saveState();
            const status = changed ? `Adjusted ${changed} box${changed === 1 ? "" : "es"}` : "No box coordinates changed";
            showStatus(status);
            return status;
          },
        });
      };
      shade.append(dialog);
      document.body.append(shade);
      refresh();
      prompt.focus();
    }
    async function openEnhancerSettings() {
      const shade = document.createElement("div"); shade.className = "mb-modal-shade mb-enhancer-shade";
      const dialog = document.createElement("div"); dialog.className = "mb-modal mb-enhancer-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
      dialog.innerHTML = `
        <h3>Text Generation Settings</h3>
        <label for="mb-enhancer-system">System Prompt</label>
        <textarea id="mb-enhancer-system" class="mb-enhancer-prompt" maxlength="12000"></textarea>
        <div class="mb-field-prompt-buttons" aria-label="Field prompts"></div>
        <details class="mb-enhancer-advanced">
          <summary>Generation Settings</summary>
          <div class="mb-enhancer-clip-status" role="status">Checking the connected CLIP input…</div>
          <label>Reasoning guidance</label>
          <select class="mb-enhancer-reasoning"><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
          <div class="mb-modal-help">The model’s template may support toggling thinking. The effort levels are guidance for the prompt.</div>
          <label>Sampling mode</label>
          <select class="mb-enhancer-sampling"><option value="on">On</option><option value="off">Off</option></select>
          <label>Maximum output tokens</label>
          <input class="mb-enhancer-max" type="number" min="16" max="32768" step="64">
          <div class="mb-modal-help">For one prompt field, start with 512–1024 tokens. Thinking may consume part of that budget.</div>
          <label>Temperature</label><input class="mb-enhancer-temperature" type="number" min="0.01" max="2" step="0.05">
          <label>Top K</label><input class="mb-enhancer-top-k" type="number" min="0" max="1000" step="1">
          <label>Top P</label><input class="mb-enhancer-top-p" type="number" min="0" max="1" step="0.01">
          <label>Min P</label><input class="mb-enhancer-min-p" type="number" min="0" max="1" step="0.01">
          <label>Repetition penalty</label><input class="mb-enhancer-repetition" type="number" min="0" max="5" step="0.05">
          <label>Presence penalty</label><input class="mb-enhancer-presence" type="number" min="0" max="5" step="0.05">
          <label>Seed</label><input class="mb-enhancer-seed" type="number" min="0" step="1">
          <label>MTP</label><select class="mb-enhancer-mtp"><option>auto</option><option>off</option><option>2</option><option>3</option><option>4</option><option>5</option><option>tree2s1</option><option>tree2s2</option><option>tree3s1</option><option>tree4s1m8</option></select>
          <div class="mb-modal-help">Speculative decoding requires a checkpoint with MTP weights.</div>
          <label class="mb-enhancer-check"><input class="mb-enhancer-jinja" type="checkbox">Use tokenizer Jinja template</label>
          <label class="mb-enhancer-check"><input class="mb-enhancer-template" type="checkbox">Use ComfyUI chat template as fallback</label>
          <div class="mb-modal-help">Jinja uses the connected tokenizer’s own template when available. With neither template active, the system instructions are included in the plain prompt.</div>
        </details>
        <div class="mb-modal-message mb-enhancer-error" aria-live="polite"></div>
        <div class="mb-modal-buttons"><button type="button" class="mb-enhancer-cancel">Cancel</button><span></span><button type="button" class="primary mb-enhancer-save">Save settings</button></div>
      `;
      shade.append(dialog); document.body.append(shade);
      const closeButton = document.createElement("button"); closeButton.type = "button"; closeButton.className = "mb-modal-close"; closeButton.title = "Close"; closeButton.setAttribute("aria-label", "Close"); closeButton.textContent = "×"; dialog.insertBefore(closeButton, dialog.firstChild);
      let fieldPromptShade = null;
      const close = () => {
        fieldPromptShade?.remove();
        shade.remove();
      };
      closeButton.onclick = dialog.querySelector(".mb-enhancer-cancel").onclick = close;
      shade.addEventListener("pointerdown", (event) => { if (event.target === shade) close(); });
      shade.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
      const previous = enhancerSettings(state.promptEnhancerSettings || {});
      const promptField = dialog.querySelector(".mb-enhancer-prompt");
      promptField.value = previous.system_prompt;
      const fieldPrompts = { ...previous.field_prompts };
      let defaultFieldPrompts = {};
      const promptButtons = dialog.querySelector(".mb-field-prompt-buttons");
      for (const [key, label] of Object.entries(FIELD_PROMPT_LABELS)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.classList.toggle("is-custom", Boolean(fieldPrompts[key]));
        button.onclick = () => {
          if (fieldPromptShade) return;
          const overlay = document.createElement("div");
          overlay.className = "mb-modal-shade";
          const panel = document.createElement("div");
          panel.className = "mb-modal mb-field-prompt-modal";
          panel.setAttribute("role", "dialog");
          panel.setAttribute("aria-modal", "true");
          panel.setAttribute("aria-label", `${label} Prompt`);
          panel.innerHTML = `
            <button type="button" class="mb-modal-close" aria-label="Close">×</button>
            <h3></h3>
            <div class="mb-modal-help">Generate and Edit add this instruction to the System Prompt for this field type.</div>
            <textarea aria-label="Field prompt" maxlength="6000"></textarea>
            <div class="mb-modal-buttons"><button type="button" class="mb-field-reset">Reset to default</button><span></span><button type="button" class="primary mb-field-apply">Apply</button></div>
          `;
          panel.querySelector("h3").textContent = `${label} Prompt`;
          const text = panel.querySelector("textarea");
          text.value = fieldPrompts[key] || defaultFieldPrompts[key] || "";
          text.placeholder = "Leave empty to use the built-in prompt.";
          const dismiss = () => {
            overlay.remove();
            fieldPromptShade = null;
            button.focus();
          };
          panel.querySelector(".mb-modal-close").onclick = dismiss;
          panel.querySelector(".mb-field-reset").onclick = () => {
            text.value = defaultFieldPrompts[key] || "";
            text.focus();
          };
          panel.querySelector(".mb-field-apply").onclick = () => {
            const value = text.value.trim();
            if (value && value !== defaultFieldPrompts[key]) fieldPrompts[key] = value;
            else delete fieldPrompts[key];
            button.classList.toggle("is-custom", Boolean(fieldPrompts[key]));
            dismiss();
          };
          overlay.append(panel);
          overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) dismiss(); });
          overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") dismiss(); });
          fieldPromptShade = overlay;
          document.body.append(overlay);
          text.focus();
        };
        promptButtons.append(button);
      }
      dialog.querySelector(".mb-enhancer-max").value = previous.max_length;
      dialog.querySelector(".mb-enhancer-temperature").value = previous.temperature;
      dialog.querySelector(".mb-enhancer-top-k").value = previous.top_k;
      dialog.querySelector(".mb-enhancer-top-p").value = previous.top_p;
      dialog.querySelector(".mb-enhancer-min-p").value = previous.min_p;
      dialog.querySelector(".mb-enhancer-repetition").value = previous.repetition_penalty;
      dialog.querySelector(".mb-enhancer-presence").value = previous.presence_penalty;
      dialog.querySelector(".mb-enhancer-seed").value = previous.seed;
      dialog.querySelector(".mb-enhancer-sampling").value = previous.sampling_mode;
      dialog.querySelector(".mb-enhancer-mtp").value = previous.mtp;
      dialog.querySelector(".mb-enhancer-reasoning").value = previous.reasoning_effort;
      dialog.querySelector(".mb-enhancer-template").checked = previous.use_default_template;
      dialog.querySelector(".mb-enhancer-jinja").checked = previous.use_jinja_template;
      dialog.querySelector(".mb-enhancer-save").onclick = () => {
        state.promptEnhancerSettings = enhancerSettings({
          max_length: dialog.querySelector(".mb-enhancer-max").value,
          temperature: dialog.querySelector(".mb-enhancer-temperature").value,
          top_k: dialog.querySelector(".mb-enhancer-top-k").value,
          top_p: dialog.querySelector(".mb-enhancer-top-p").value,
          min_p: dialog.querySelector(".mb-enhancer-min-p").value,
          repetition_penalty: dialog.querySelector(".mb-enhancer-repetition").value,
          presence_penalty: dialog.querySelector(".mb-enhancer-presence").value,
          seed: dialog.querySelector(".mb-enhancer-seed").value,
          sampling_mode: dialog.querySelector(".mb-enhancer-sampling").value,
          mtp: dialog.querySelector(".mb-enhancer-mtp").value,
          reasoning_effort: dialog.querySelector(".mb-enhancer-reasoning").value,
          use_default_template: dialog.querySelector(".mb-enhancer-template").checked,
          use_jinja_template: dialog.querySelector(".mb-enhancer-jinja").checked,
          system_prompt: promptField.value,
          edit_system_prompt: previous.edit_system_prompt,
          geometry_system_prompt: previous.geometry_system_prompt,
          field_prompts: fieldPrompts,
          context_mode: previous.context_mode,
        });
        syncWidgets();
        close();
      };
      try {
        const response = await fetch(enhancerOptionsUrl(), { credentials: "same-origin" });
        const options = await response.json();
        if (!response.ok) throw new Error(options.error || "Could not check the connected CLIP input.");
        defaultFieldPrompts = options.default_field_prompts || {};
        const clipStatus = dialog.querySelector(".mb-enhancer-clip-status");
        if (!clipSocketConnected()) clipStatus.textContent = "No CLIP input is connected. Connect a CLIP encoder to this node.";
        else if (!options.clip_available) clipStatus.textContent = "CLIP is connected. Template support is checked when the text job runs.";
        else {
          const templateState = options.jinja_template_available
            ? " · tokenizer Jinja template available"
            : " · no tokenizer Jinja template found";
          clipStatus.textContent = `Connected CLIP: ${options.clip_name}${templateState}`;
        }
        const promptFingerprint = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const isPreviousBuiltIn = (options.legacy_default_system_prompts || []).some((value) => promptFingerprint(value) === promptFingerprint(promptField.value));
        if ((!promptField.value.trim() || isPreviousBuiltIn) && options.default_system_prompt) promptField.value = options.default_system_prompt;
      } catch (error) {
        dialog.querySelector(".mb-enhancer-error").textContent = error.message || String(error);
      }
    }
    function displayItems() { return state.items; }
    function refreshTranslationStatus() {
      const status = $(".mb-translation-status");
      const action = runningAction ?? pendingActions.values().next().value;
      const waiting = pendingActions.size - Number(Boolean(runningAction));
      status.textContent = action ? `${action.status}${waiting > 0 ? ` · ${waiting} queued` : ""}`
        : activeOperationStatus || "Prompt ready";
      if (action) setEnhancerProgress(action.progress);
      status.title = status.textContent;
    }
    function syncWidgets() {
      sourceSummary = summary.value;
      sourceMeta = meta.value;
      delete state.mossQueuedAction;
      delete state.translated;
      delete state.translationView;
      refreshTranslationStatus();
      setValue(node, "aspect_ratio", ratioSelect.value);
      setValue(node, "resolution", mpSelect.value);
      setValue(node, "width", roundDimension(wInput.value));
      setValue(node, "height", roundDimension(hInput.value));
      setValue(node, "megapixels", Math.max(.25, Number(mpInput.value) || 1));
      setValue(node, "dimension_multiple", "16");
      setValue(node, "summary", sourceSummary);
      setValue(node, "summary_meta", sourceMeta);
      state.summaryPalette = summaryPalette;
      state.recentColors = recentColors.slice(0, 10);
      state.coordinateSpace = "workspace";
      state.orientation = landscapeOrientation ? "landscape" : "portrait";
      state.workspaceAspect = 1;
      delete state.autoTranslate;
      if (canvasType.value) state.summaryCanvas = canvasType.value;
      else delete state.summaryCanvas;
      state.backgroundOpacity = backgroundOpacity;
      state.backgroundVisible = backgroundVisible;
      setValue(node, "portrait", landscapeOrientation);
      updateContextControl();
      setValue(node, "prompt_enhancer_settings", JSON.stringify(state.promptEnhancerSettings || {}));
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

    function rememberColor(color) {
      if (!/^#[0-9a-f]{6}$/i.test(color)) return;
      recentColors = [color.toLowerCase(), ...recentColors.filter((entry) => entry.toLowerCase() !== color.toLowerCase())].slice(0, 10);
      state.recentColors = recentColors;
    }
    function visualBoxColor(item) {
      let color = boxUiColors.get(item);
      if (!color) {
        const hue = Math.floor(Math.random() * 360), saturation = 54 + Math.floor(Math.random() * 18), lightness = 56 + Math.floor(Math.random() * 12);
        color = `hsl(${hue} ${saturation}% ${lightness}%)`;
        boxUiColors.set(item, color);
      }
      return color;
    }

    function fieldRect() {
      const r = Math.max(1e-9, (Number(wInput.value) || 1024) / Math.max(1, Number(hInput.value) || 1024));
      const workspaceWidth = CW, workspaceHeight = CH, workspaceAspect = 1;
      const frameWidth = workspaceAspect >= r ? workspaceHeight * r : workspaceWidth;
      const frameHeight = frameWidth / r;
      const x = (workspaceWidth - frameWidth) / 2;
      const y = (workspaceHeight - frameHeight) / 2;
      return {
        x: x * CW / workspaceWidth,
        y: y * CH / workspaceHeight,
        w: frameWidth * CW / workspaceWidth,
        h: frameHeight * CH / workspaceHeight,
      };
    }
    function migrateItemsToWorkspace() {
      if (state.coordinateSpace === "workspace") return;
      const aspect = Math.max(1e-9, (Number(wInput.value) || 1024) / Math.max(1, Number(hInput.value) || 1024));
      const width = aspect >= 1 ? 1 : aspect, height = aspect >= 1 ? 1 / aspect : 1;
      const left = (1 - width) / 2, top = (1 - height) / 2;
      state.items = state.items.map((item) => {
        const box = item.bbox || [0, 0, 1, 1];
        return { ...item, bbox: [left + box[0] * width, top + box[1] * height, left + box[2] * width, top + box[3] * height] };
      });
      state.coordinateSpace = "workspace";
      state.workspaceAspect = 1;
    }
    function normalizedGenerationFrame(workspaceAspect, generationAspect) {
      const frameWidth = workspaceAspect >= generationAspect ? generationAspect / workspaceAspect : 1;
      const frameHeight = frameWidth / generationAspect;
      return { x: (1 - frameWidth) / 2, y: (1 - frameHeight) / 2, w: frameWidth, h: frameHeight };
    }
    function migrateWorkspaceToSquare() {
      if (state.coordinateSpace !== "workspace") return;
      const oldAspect = Number(state.workspaceAspect);
      if (!Number.isFinite(oldAspect) || oldAspect <= 0 || Math.abs(oldAspect - 1) < 0.0001) { state.workspaceAspect = 1; return; }
      const generationAspect = Math.max(1e-9, (Number(wInput.value) || 1024) / Math.max(1, Number(hInput.value) || 1024));
      const oldFrame = normalizedGenerationFrame(oldAspect, generationAspect), newFrame = normalizedGenerationFrame(1, generationAspect);
      const remap = (items) => Array.isArray(items) ? items.map((item) => {
        const box = item.bbox || [0,0,1,1];
        return { ...item, bbox: [
          newFrame.x + (box[0] - oldFrame.x) / oldFrame.w * newFrame.w,
          newFrame.y + (box[1] - oldFrame.y) / oldFrame.h * newFrame.h,
          newFrame.x + (box[2] - oldFrame.x) / oldFrame.w * newFrame.w,
          newFrame.y + (box[3] - oldFrame.y) / oldFrame.h * newFrame.h,
        ] };
      }) : items;
      state.items = remap(state.items);
      state.workspaceAspect = 1;
    }
    function canvasContentRect() {
      const rect = canvas.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    function generationBoxToWorkspace(box) {
      const frame = fieldRect();
      return [(frame.x + box[0] * frame.w) / CW, (frame.y + box[1] * frame.h) / CH,
              (frame.x + box[2] * frame.w) / CW, (frame.y + box[3] * frame.h) / CH];
    }
    function boxPx(box) {
      return [box[0] * CW, box[1] * CH, box[2] * CW, box[3] * CH];
    }
    function canvasPoint(event) {
      const cr = canvasContentRect();
      const x = (event.clientX - cr.left) * CW / cr.width, y = (event.clientY - cr.top) * CH / cr.height;
      const frame = fieldRect();
      const inside = x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h;
      return { px: x, py: y, x: Math.max(0, Math.min(1, x / CW)), y: Math.max(0, Math.min(1, y / CH)), inside };
    }
    function clampPointToGeneration(point) {
      const frame = fieldRect();
      const px = Math.max(frame.x, Math.min(frame.x + frame.w, point.px));
      const py = Math.max(frame.y, Math.min(frame.y + frame.h, point.py));
      return { ...point, px, py, x: px / CW, y: py / CH, inside: true };
    }
    function constrainBoxToGeneration(box) {
      const frame = fieldRect();
      const left = frame.x / CW, top = frame.y / CH;
      const right = (frame.x + frame.w) / CW, bottom = (frame.y + frame.h) / CH;
      const width = Math.min(right - left, Math.max(.008, box[2] - box[0]));
      const height = Math.min(bottom - top, Math.max(.008, box[3] - box[1]));
      const x1 = Math.max(left, Math.min(right - width, box[0]));
      const y1 = Math.max(top, Math.min(bottom - height, box[1]));
      return [x1, y1, x1 + width, y1 + height];
    }
    function paintPreview() {
      if (!latestPreview?.complete || !latestPreview.naturalWidth) return;
      const r = fieldRect(), scale = Math.min(r.w / latestPreview.naturalWidth, r.h / latestPreview.naturalHeight);
      const w = latestPreview.naturalWidth * scale, h = latestPreview.naturalHeight * scale;
      const x = r.x + (r.w - w) / 2, y = r.y + (r.h - h) / 2;
      const visibleX = Math.max(r.x, x), visibleY = Math.max(r.y, y);
      const visibleRight = Math.min(r.x + r.w, x + w), visibleBottom = Math.min(r.y + r.h, y + h);
      previewRect = { x: visibleX, y: visibleY, w: visibleRight - visibleX, h: visibleBottom - visibleY, imageX: x, imageY: y, imageW: w, imageH: h };
      if (!backgroundVisible || backgroundOpacity <= 0) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      ctx.globalAlpha = backgroundOpacity / 100;
      ctx.drawImage(latestPreview, x, y, w, h);
      ctx.restore();
    }
    function draw() {
      ctx.clearRect(0, 0, CW, CH);
      ctx.fillStyle = "#0e1214"; ctx.fillRect(0, 0, CW, CH);
      const r = fieldRect();
      ctx.fillStyle = "#252b2d"; ctx.fillRect(r.x, r.y, r.w, r.h);
      paintPreview();
      ctx.strokeStyle = "rgba(205,216,219,.46)"; ctx.lineWidth = 1.5; ctx.setLineDash([7, 6]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]);
      ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      displayItems().forEach((item, index) => {
        const [x1, y1, x2, y2] = boxPx(item.bbox || [0, 0, 1, 1]);
        const color = visualBoxColor(item);
        ctx.fillStyle = color; ctx.globalAlpha = .13; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); ctx.globalAlpha = 1;
        ctx.strokeStyle = color; ctx.globalAlpha = index === selected ? .72 : .56; ctx.lineWidth = index === selected ? 2.6 : 1.7; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1); ctx.globalAlpha = 1;
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
          ctx.fillStyle = "rgba(12,16,18,.58)"; ctx.fillRect(x1, bandY, boxWidth, bandHeight);
          ctx.fillStyle = "#e3e9eb"; ctx.globalAlpha = .72;
          lines.forEach((text, i) => ctx.fillText(text, x1 + 4, bandY + 10 + i * lineHeight, textWidth));
          ctx.globalAlpha = 1;
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
          ctx.fillStyle = "rgba(12,16,18,.62)"; ctx.fillRect(badgeX, badgeY, badgeWidth, 14);
          ctx.fillStyle = "#e3e9eb"; ctx.globalAlpha = .72; ctx.fillText(fittedText, badgeX + 5, badgeY + 10, badgeWidth - 10); ctx.globalAlpha = 1;
          ctx.restore();
        }
        if (index === selected) {
          ctx.fillStyle = "#e5ecee";
          for (const [x, y] of [[x1,y1],[x2,y1],[x1,y2],[x2,y2]]) { ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); }
        }
      });
      ctx.restore();
      if (gesture?.mode === "create" && gesture.current) {
        const a = gesture.start, b = gesture.current;
        const x = Math.min(a.x,b.x)*CW, y = Math.min(a.y,b.y)*CH;
        const w = Math.abs(a.x-b.x)*CW, h = Math.abs(a.y-b.y)*CH;
        ctx.fillStyle = "rgba(158,175,180,.12)"; ctx.fillRect(x,y,w,h);
        ctx.strokeStyle = "#9eafb4"; ctx.lineWidth = 1.8; ctx.setLineDash([5,4]); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
      }
      emptyHint.style.display = state.items.length ? "none" : "block";
      renderSidebar();
      const resolution = `${roundDimension(wInput.value)} × ${roundDimension(hInput.value)} px`;
      $(".mb-size-row").title = `Canvas size: ${resolution}`;
    }

    function saveState() { savedState.value = JSON.stringify(state); syncWidgets(); draw(); }
    function renderSidebar(){const list=$(".mb-elements");list.innerHTML="";displayItems().forEach((item,i)=>{const b=document.createElement("button");b.type="button";b.className="mb-element"+(i===selected?" selected":"");b.textContent=`${TYPE_NAME[item.label]||"Object"} ${i+1}: ${item.caption||item.text||"(no description)"}`;b.onclick=()=>{selected=i;canvas.focus();draw();};b.ondblclick=()=>openEditor(i,innerWidth/2,innerHeight/2);list.append(b);});const pal=$(".mb-global-palette");pal.innerHTML="";summaryPalette.forEach((color,i)=>{const chip=document.createElement("span");chip.className="mb-color-chip";chip.innerHTML=`<input type="color" value="${/^#[0-9a-f]{6}$/i.test(color)?color:"#b4c0c5"}"><button type="button" title="Remove color">×</button>`;chip.querySelector("input").oninput=e=>{summaryPalette[i]=e.target.value;syncWidgets();};chip.querySelector("button").onclick=()=>{summaryPalette.splice(i,1);syncWidgets();draw();};pal.append(chip);});}
    function translateFields(fields) {
      fields = fields.filter((field) => typeof field?.text === "string" && field.text.trim());
      if (!fields.length) { $(".mb-translation-status").textContent = "Add text to a field before translating"; return; }
      const settings = translationSettings(state.translationSettings || {});
      state.translationSettings = settings;
      syncWidgets();
      const segments = fields.map((field) => ({ id: field.id, text: field.text }));
      return runTextAction("translate", { segments, settings }, fields, "Translating", {
        apply: (result, snapshots) => {
          const { applied, skipped } = applyActionValues(snapshots, result);
          if (applied) saveState();
          const status = applied ? `Translated ${applied} field${applied === 1 ? "" : "s"}` : "No fields changed";
          return skipped ? `${status} · ${skipped} changed after submission` : status;
        },
      });
    }
    async function openTranslationSettings() {
      const shade = document.createElement("div"); shade.className = "mb-modal-shade mb-translation-shade";
      const dialog = document.createElement("div"); dialog.className = "mb-modal mb-translation-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
      dialog.innerHTML = `<h3>Translation settings</h3><div class="mb-modal-help">These settings are shared by Translate all and the field translation icons.</div><label>Source language</label><select class="mb-source-language"><option>Auto Detect</option></select><label>Target language</label><select class="mb-target-language"></select><label>TranslateGemma model</label><select class="mb-model-size"><option>4B</option><option>12B</option><option>27B</option></select><details class="mb-translation-advanced"><summary>Advanced settings</summary><label>Device</label><select class="mb-device"><option value="default">Default</option><option value="cpu">CPU</option></select><label>Prompt mode</label><select class="mb-prompt-mode"><option value="auto">Auto</option><option value="structured">Structured</option><option value="plain">Plain</option></select><label>Quantization</label><select class="mb-quantization"><option value="none">None</option><option value="bnb-8bit">8-bit</option><option value="bnb-4bit">4-bit</option></select><label>Max input tokens (0 = automatic)</label><input class="mb-max-input" type="number" min="0" max="8192" value="0"><label>Max new tokens (0 = automatic)</label><input class="mb-max-new" type="number" min="0" max="8192" value="0"><label><input class="mb-keep-loaded" type="checkbox" checked> Keep model loaded after translation</label></details><div class="mb-translation-message" aria-live="polite">TranslateGemma runs locally. The first run may download model weights.</div><div class="mb-modal-buttons"><button class="mb-translation-cancel">Cancel</button><span></span><button class="primary mb-translation-save-settings">Save settings</button></div>`;
      shade.append(dialog); document.body.append(shade);
      const closeButton = document.createElement("button"); closeButton.type = "button"; closeButton.className = "mb-modal-close"; closeButton.title = "Close"; closeButton.setAttribute("aria-label", "Close"); closeButton.textContent = "×"; dialog.insertBefore(closeButton, dialog.firstChild);
      const sourceSelect = dialog.querySelector(".mb-source-language"), targetSelect = dialog.querySelector(".mb-target-language");
      const message = dialog.querySelector(".mb-translation-message"), saveSettingsButton = dialog.querySelector(".mb-translation-save-settings");
      const collectSettings = () => translationSettings({
        source_language: sourceSelect.value, target_language: targetSelect.value,
        model_size: dialog.querySelector(".mb-model-size").value,
        device: dialog.querySelector(".mb-device").value, prompt_mode: dialog.querySelector(".mb-prompt-mode").value,
        quantization: dialog.querySelector(".mb-quantization").value,
        max_input_tokens: dialog.querySelector(".mb-max-input").value,
        max_new_tokens: dialog.querySelector(".mb-max-new").value,
        keep_model_loaded: dialog.querySelector(".mb-keep-loaded").checked,
      });
      saveSettingsButton.onclick = () => { state.translationSettings = collectSettings(); syncWidgets(); close(); };
      const previous = translationSettings(state.translationSettings || {});
      dialog.querySelector(".mb-model-size").value = previous.model_size;
      dialog.querySelector(".mb-device").value = previous.device;
      dialog.querySelector(".mb-prompt-mode").value = previous.prompt_mode;
      dialog.querySelector(".mb-quantization").value = previous.quantization;
      dialog.querySelector(".mb-max-input").value = String(previous.max_input_tokens);
      dialog.querySelector(".mb-max-new").value = String(previous.max_new_tokens);
      dialog.querySelector(".mb-keep-loaded").checked = previous.keep_model_loaded;
      const close = () => shade.remove();
      closeButton.onclick = dialog.querySelector(".mb-translation-cancel").onclick = close;
      shade.addEventListener("pointerdown", (event) => { if (event.target === shade) close(); });
      shade.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
      try {
        const response = await fetch(typeof app.api?.apiURL === "function" ? app.api.apiURL("/moss_layout_ydr/translation/languages") : "/moss_layout_ydr/translation/languages", { credentials: "same-origin" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load the language list.");
        if (!Array.isArray(payload.languages) || payload.languages.length === 0) throw new Error("The local language list is empty.");
        for (const language of payload.languages || []) {
          const sourceOption = new Option(language, language), targetOption = new Option(language, language);
          sourceSelect.add(sourceOption); targetSelect.add(targetOption);
        }
        const savedSettings = state.translationSettings || {};
        sourceSelect.value = savedSettings.source_language || "Auto Detect";
        targetSelect.value = savedSettings.target_language || "English";
        if (Array.isArray(payload.devices)) for (const device of payload.devices) if (!["default", "cpu"].includes(device)) dialog.querySelector(".mb-device").add(new Option(device, device));
      } catch (error) {
        message.textContent = "Could not load translation options: " + (error.message || String(error));
        saveSettingsButton.disabled = true;
      }
    }
    function hitItemsAt(x, y) {
      const hits = [];
      for (let i = state.items.length - 1; i >= 0; i--) {
        const [x1,y1,x2,y2] = boxPx(state.items[i].bbox);
        if (x >= x1 && x <= x2 && y >= y1 && y <= y2) hits.push(state.items[i]);
      }
      return hits;
    }
    function boxAt(x, y, alt = false) {
      const hits = hitItemsAt(x, y);
      if (!hits.length) { if (alt) altPickCycle = null; return -1; }
      let item = hits[0];
      if (alt && hits.length > 1) {
        const samePoint = altPickCycle && Math.abs(altPickCycle.x - x) < 12 && Math.abs(altPickCycle.y - y) < 12;
        const sameItems = samePoint && altPickCycle.items.length === hits.length && hits.every((entry) => altPickCycle.items.includes(entry));
        if (!sameItems) altPickCycle = { x, y, items: hits, cursor: 1 };
        item = altPickCycle.items[altPickCycle.cursor % altPickCycle.items.length];
        altPickCycle.cursor++;
        const oldIndex = state.items.indexOf(item);
        if (oldIndex >= 0 && oldIndex !== state.items.length - 1) {
          state.items.splice(oldIndex, 1);
          state.items.push(item);
        }
      } else if (!alt) altPickCycle = null;
      return state.items.indexOf(item);
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
      item.bbox = [Math.max(0, Math.min(1, x1/CW)), Math.max(0, Math.min(1, y1/CH)),
                   Math.max(0, Math.min(1, x2/CW)), Math.max(0, Math.min(1, y2/CH))];
    }
    function createBox(start, end) {
      start = clampPointToGeneration(start);
      end = clampPointToGeneration(end);
      const item = { label: "object", caption: "", bbox: [Math.min(start.x,end.x),Math.min(start.y,end.y),Math.max(start.x,end.x),Math.max(start.y,end.y)] };
      if (item.bbox[2] - item.bbox[0] < .008 || item.bbox[3] - item.bbox[1] < .008) return;
      item.bbox = constrainBoxToGeneration(item.bbox);
      state.items.push(item); selected = state.items.length - 1; saveState();
    }

    function openEditor(index, clientX, clientY) {
      const item = state.items[index]; if (!item) return;
      const shade = document.createElement("div"); shade.className = "mb-modal-shade";
      const dialog = document.createElement("div"); dialog.className = "mb-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
      dialog.innerHTML = `<h3>Edit ${TYPE_NAME[item.label] || "Object"}</h3>
        <label title="MOSS item label controls whether the box describes an object, a character, or visible text.">Element type</label>
        <select class="mb-kind"><option value="object">Object</option><option value="character">Character</option><option value="text">Text</option></select>
        <div class="mb-caption-wrap"><div class="mb-field-head"><label title="Describe the visible appearance and details inside this region.">Description</label><div class="mb-field-actions"><button class="mb-translate-field mb-translate-caption" type="button" aria-label="Translate box description" title="Translate only this box description">${TRANSLATE_ICON}</button><button class="mb-enhance-field mb-enhance-caption" type="button" title="Generate improved text for only this box description">Generate</button></div></div><textarea class="mb-caption" placeholder="Describe the visible appearance, pose, materials, or typography…"></textarea><div class="mb-modal-help">This caption describes what should appear inside this box.</div></div>
        <div class="mb-exact-wrap"><div class="mb-field-head"><label title="Enter the exact visible characters. Preserve line breaks when needed.">Exact visible text</label><div class="mb-field-actions"><button class="mb-translate-field mb-translate-exact" type="button" aria-label="Translate exact visible text" title="Translate only this field">${TRANSLATE_ICON}</button><button class="mb-enhance-field mb-enhance-exact" type="button" title="Generate an improved version of only this exact visible text">Generate</button></div></div><textarea class="mb-exact" placeholder="Type the exact words to render…"></textarea><div class="mb-modal-help">Required for a Text element. Keep exact spelling and line breaks here.</div></div>
        <div class="mb-field-head"><label title="Optional visual tags for this item, separated by commas.">Tags <span class="mb-modal-help">Optional comma-separated visual tags</span></label><div class="mb-field-actions"><button class="mb-translate-field mb-translate-tags" type="button" aria-label="Translate box tags" title="Translate only these tags">${TRANSLATE_ICON}</button><button class="mb-enhance-field mb-enhance-tags" type="button" title="Generate improved tags for only this box">Generate</button></div></div><input class="mb-tags" placeholder="e.g. foreground, warm lighting"/>
        <label title="Optional colors associated with this box.">Palette <span class="mb-modal-help">Choose colors for this element. Colors appear as a stripe on its box.</span></label><div class="mb-item-palette"></div><div class="mb-palette-tools"><button class="mb-add-item-color" type="button">＋ Add color</button></div>
        <div class="mb-modal-buttons"><button class="danger mb-delete">Delete box</button><span></span><button class="mb-cancel">Cancel</button><button class="primary mb-save">Save</button></div>`;
      shade.append(dialog); document.body.append(shade);
      const kind = dialog.querySelector(".mb-kind"), caption = dialog.querySelector(".mb-caption"), exact = dialog.querySelector(".mb-exact");
      const tagsControl = dialog.querySelector(".mb-tags");
      const captionWrap = dialog.querySelector(".mb-caption-wrap"), exactWrap = dialog.querySelector(".mb-exact-wrap");
      kind.value = item.label || "object"; caption.value = item.caption || ""; exact.value = item.text || "";
      tagsControl.value = (item.tags || []).join(", ");
      const savedText = (field) => field === "tags" ? (item.tags || []).join(", ") : item[field] || "";
      const textControls = { caption, text: exact, tags: tagsControl };
      const editor = {
        readSaved: () => Object.fromEntries(Object.keys(textControls).map((field) => [field, savedText(field)])),
        refresh: (before) => {
          for (const [field, control] of Object.entries(textControls)) {
            if (control.value === before[field]) control.value = savedText(field);
          }
        },
      };
      openBoxTextEditor = editor;
      const currentText = (field, control) => {
        if (!state.items.includes(item)) return null;
        if (!shade.isConnected) return savedText(field);
        if (field === "tags") return sourceMetaParts(control.value).join(", ");
        return field === "caption" ? control.value.trim() : control.value;
      };
      let draftPalette = [...(item.palette || [])]; const paletteHost=dialog.querySelector(".mb-item-palette"); const renderPalette=()=>{paletteHost.innerHTML="";draftPalette.forEach((color,i)=>{const chip=document.createElement("span");chip.className="mb-color-chip";chip.innerHTML=`<input type="color" value="${/^#[0-9a-f]{6}$/i.test(color)?color:"#9eafb4"}"><button type="button" title="Remove color">×</button>`;chip.querySelector("input").oninput=e=>draftPalette[i]=e.target.value;chip.querySelector("button").onclick=()=>{draftPalette.splice(i,1);renderPalette();};paletteHost.append(chip);});};renderPalette();
      const updateType = () => {
        captionWrap.querySelector("label").textContent = kind.value === "text" ? "Text description and style" : "Description";
        captionWrap.querySelector(".mb-modal-help").textContent = kind.value === "text" ? "Describe lettering style, color, size, alignment, and surface treatment. Enter exact characters below." : "Describe the visible appearance here. Exact visible text is optional for objects and characters.";
        exactWrap.querySelector("label").textContent = kind.value === "text" ? "Exact visible text (required)" : "Exact visible text (optional)";
        exactWrap.querySelector(".mb-modal-help").textContent = kind.value === "text" ? "Required for a Text element; preserve spelling and line breaks." : "Optional literal text associated with this object or character.";
        exactWrap.style.display = "block";
      };
      updateType(); kind.addEventListener("change", updateType);
      const enhanceModalField = (selector, control, field, fieldType) => {
        const button = dialog.querySelector(selector);
        button.addEventListener("click", () => {
          saveItem(false); saveState();
          enhanceFields([{
            id: `item.${index}.${field}`, type: typeof fieldType === "function" ? fieldType() : fieldType,
            text: control.value, current: () => currentText(field, control),
            apply: (value) => {
              control.value = value;
              if (!state.items.includes(item)) return;
              if (field === "caption") item.caption = value;
              else if (field === "text") { if (value.trim()) item.text = value; else delete item.text; }
              else if (field === "tags") item.tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
            },
          }]);
        });
      };
      enhanceModalField(".mb-enhance-caption", caption, "caption", () => `${TYPE_NAME[kind.value] || "Object"} description`);
      enhanceModalField(".mb-enhance-exact", exact, "text", "exact visible text");
      enhanceModalField(".mb-enhance-tags", tagsControl, "tags", "box tags");
      const translateModalField = (selector, control, field) => {
        dialog.querySelector(selector).addEventListener("click", () => {
          saveItem(false);
          if (!state.items.includes(item)) return;
          if (field === "caption") control.value = item.caption || "";
          else if (field === "text") control.value = item.text || "";
          else control.value = (item.tags || []).join(", ");
          saveState();
          if (field === "tags") {
            const tagFields = gatherTranslationFields().filter((entry) => entry.id.startsWith(`item.${index}.tags.`));
            const boundFields = tagFields.map((entry) => ({
              ...entry,
              current: () => sourceMetaParts(currentText("tags", control))[Number(entry.id.split(".").at(-1))] ?? null,
              apply: (value) => { entry.apply(value); control.value = savedText("tags"); },
            }));
            translateFields(boundFields);
            return;
          }
          translateFields([{
            id: `item.${index}.${field}`, text: control.value,
            current: () => currentText(field, control),
              apply: (value) => { control.value = value; if (!state.items.includes(item)) return; if (field === "caption") item.caption = value; else item.text = value; },
          }]);
        });
      };
      translateModalField(".mb-translate-caption", caption, "caption");
      translateModalField(".mb-translate-exact", exact, "text");
      translateModalField(".mb-translate-tags", tagsControl, "tags");
      const close = () => {
        if (openBoxTextEditor === editor) openBoxTextEditor = undefined;
        shade.remove();
      };
      shade.addEventListener("pointerdown", (event) => { if (event.target === shade) { saveItem(false); saveState(); close(); } });
      dialog.querySelector(".mb-cancel").onclick = close;
      const closeButton = document.createElement("button");
      closeButton.type = "button"; closeButton.className = "mb-modal-close"; closeButton.title = "Save and close"; closeButton.setAttribute("aria-label", "Save and close"); closeButton.textContent = "×";
      dialog.insertBefore(closeButton, dialog.firstChild);
      dialog.querySelector(".mb-delete").onclick = () => { state.items.splice(index, 1); selected = -1; saveState(); close(); };
      const saveItem = (validate = true) => {
        const captionValue = caption.value.trim();
        const exactValue = exact.value;
        const tags = dialog.querySelector(".mb-tags").value.split(",").map((x)=>x.trim()).filter(Boolean);
        if (validate && kind.value === "text" && (!captionValue || !exactValue.trim())) {
          window.alert("Text elements need both typography/style and exact visible text. The box position is set on the canvas.");
          return false;
        }
        const palette = draftPalette;
        if (!state.items.includes(item)) return false;
        item.label = kind.value;
        item.caption = captionValue;
        if (exactValue.trim()) item.text = exactValue; else delete item.text;
        if (tags.length) item.tags = tags; else delete item.tags;
        if (palette.length) item.palette = palette; else delete item.palette;
        return true;
      };
      dialog.querySelector(".mb-modal-close").onclick = () => { saveItem(false); saveState(); close(); };
      dialog.querySelector(".mb-add-item-color").onclick = (event) => openColorPopover(event.currentTarget, (color) => { draftPalette.push(color); rememberColor(color); renderPalette(); }, recentColors);
      dialog.querySelector(".mb-save").onclick = () => { if (!saveItem()) return; saveState(); close(); };
      dialog.querySelector(".mb-caption").focus();
      // Keep the editor near the pointer where possible, matching the DENO board workflow.
      dialog.style.transform = `translate(${clientX < innerWidth/2 ? "4vw" : "-4vw"},0)`;
    }

    canvas.tabIndex = 0;
    canvas.addEventListener("pointerdown", (event) => {
      if (app.canvas?.dragging_canvas || app.canvas?.read_only) return;
      if (event.button !== 0) return;
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
          const ix = Math.max(0, Math.min(scratch.width - 1, Math.floor((p.px - previewRect.imageX) / previewRect.imageW * scratch.width)));
          const iy = Math.max(0, Math.min(scratch.height - 1, Math.floor((p.py - previewRect.imageY) / previewRect.imageH * scratch.height)));
          const rgb = sc.getImageData(ix, iy, 1, 1).data;
          const sampledColor = `#${[...rgb].slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("")}`;
          sampleMode.target.push(sampledColor); rememberColor(sampledColor);
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
      if (!gesture) { const hit=p.inside?boxAt(p.px,p.py,false):-1;canvas.style.cursor=hit>=0?(edgeAt(state.items[hit].bbox,p.px,p.py)==="move"?"move":"nwse-resize"):"crosshair";return; }
      if (gesture.mode === "create") { gesture.current = clampPointToGeneration(p); draw(); return; }
      const box = [...gesture.original], dx = (p.px - gesture.start.px) / CW, dy = (p.py - gesture.start.py) / CH;
      if (gesture.mode === "move") { box[0]+=dx;box[2]+=dx;box[1]+=dy;box[3]+=dy; }
      else { if (gesture.mode.includes("l")) box[0]+=dx;if (gesture.mode.includes("r")) box[2]+=dx;if (gesture.mode.includes("t")) box[1]+=dy;if (gesture.mode.includes("b")) box[3]+=dy; }
      const nx=Math.max(0,Math.min(1,box[0])),ny=Math.max(0,Math.min(1,box[1]));
      const ex=Math.max(0,Math.min(1,box[2])),ey=Math.max(0,Math.min(1,box[3]));
      if (gesture.mode === "move") {const bw=box[2]-box[0],bh=box[3]-box[1];box[0]=Math.max(0,Math.min(1-bw,box[0]));box[2]=box[0]+bw;box[1]=Math.max(0,Math.min(1-bh,box[1]));box[3]=box[1]+bh;}
      else {box[0]=Math.min(nx,ex);box[2]=Math.max(nx,ex);box[1]=Math.min(ny,ey);box[3]=Math.max(ny,ey);}
      state.items[selected].bbox=constrainBoxToGeneration(box);draw();
    });
    canvas.addEventListener("pointerup", (event) => {
      if (!gesture) return;
      if (gesture.mode === "create") createBox(gesture.start, gesture.current || canvasPoint(event));
      else saveState();
      gesture=null;canvas.style.cursor="crosshair";draw();
    });
    canvas.addEventListener("dblclick", (event) => {
      event.stopPropagation();const p=canvasPoint(event);if(!p.inside)return;const hit=event.altKey&&selected>=0?selected:boxAt(p.px,p.py,false);
      if(hit>=0){selected=hit;saveState();openEditor(hit,event.clientX,event.clientY);}
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
        coordinateSpace: "workspace",
        backgroundOpacity,
        backgroundVisible,
        lastLayoutInputHash: state.lastLayoutInputHash || "",
        suppressLayoutInput: inputLinked,
        suppressLayoutHash: inputLinked ? (state.lastLayoutInputHash || "") : "",
      };
      selected = -1; sampleMode = null; summary.value = ""; meta.value = ""; sourceSummary = ""; sourceMeta = ""; canvasType.value = ""; summaryPalette = []; recentColors = [];
      delete state.autoTranslate; delete state.translationSettings;
      landscapeOrientation = false;
      ratioSelect.value = "1:1"; mpSelect.value = "1 MP"; mpInput.value = "1"; wInput.value = "1024"; hInput.value = "1024";
      syncWidgets(); draw();
    });
    function swapOrientationPreservingBoxes() {
      if (ratioSelect.value === "Custom") {
        const oldWidth = wInput.value;
        wInput.value = hInput.value;
        hInput.value = oldWidth;
      } else {
        landscapeOrientation = !landscapeOrientation;
      }
      syncSizeFields();
    }
    $(".mb-swap").addEventListener("click",swapOrientationPreservingBoxes);
    summary.addEventListener("input",syncWidgets);
    meta.addEventListener("input",syncWidgets);
    canvasType.addEventListener("change",syncWidgets);
    contextSlider?.addEventListener("input", () => {
      const settings = enhancerSettings(state.promptEnhancerSettings || {});
      settings.context_mode = CONTEXT_MODES[Number(contextSlider.value)] || "full";
      state.promptEnhancerSettings = enhancerSettings(settings);
      updateContextControl();
      syncWidgets();
    });
    $(".mb-translate-all").addEventListener("click", () => translateFields(gatherTranslationFields()));
    $(".mb-translate-settings").addEventListener("click",openTranslationSettings);
    root.querySelectorAll(".mb-enhancer-settings").forEach((button) => button.addEventListener("click",openEnhancerSettings));
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
      clearTimeout(enhancerProgressHideTimer);
      const removedNodeId = String(node.id);
      // ComfyUI can tear down and rebuild frontend node instances while loading
      // or replacing a workflow. Delay release so a replacement with the same
      // workflow ID keeps the backend CLIP reference it relies on.
      setTimeout(() => {
        const graph = app.graph || app.rootGraph;
        const graphNodes = graph?._nodes || graph?.nodes;
        const replacementExists = Array.isArray(graphNodes)
          && graphNodes.some((entry) => String(entry.id) === removedNodeId);
        if (replacementExists) return;
        fetch(enhancerUrl("release"), {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: removedNodeId }),
        }).catch(() => {});
      }, 1500);
      return originalOnRemoved?.apply(this, args);
    };
    $(".mb-enhance-field[data-enhance-target='summary']").addEventListener("click", () => enhanceFields([{
      id: "summary.caption", type: "whole-image summary", text: summary.value,
      current: () => summary.value, apply: (value) => showReplacedText(summary, value),
    }]));
    $(".mb-enhance-field[data-enhance-target='meta']").addEventListener("click", () => enhanceFields([{
      id: "summary.meta", type: "summary metadata tags", text: meta.value,
      current: () => meta.value, apply: (value) => { meta.value = value; },
    }]));
    $(".mb-translate-field[data-translate-target='summary']").addEventListener("click", () => translateFields(gatherTranslationFields().filter((field) => field.id === "summary.caption")));
    $(".mb-translate-field[data-translate-target='meta']").addEventListener("click", () => translateFields(gatherTranslationFields().filter((field) => field.id.startsWith("summary.meta."))));
    $(".mb-enhance-all").addEventListener("click", () => enhanceFields(gatherEnhanceAllFields()));
    $(".mb-edit-matching").addEventListener("click", openTargetedEditDialog);
    $(".mb-add-summary-color").addEventListener("click",(event)=>openColorPopover(event.currentTarget,(color)=>{summaryPalette.push(color);rememberColor(color);syncWidgets();draw();},recentColors));$(".mb-pick-summary").addEventListener("click",()=>{sampleMode={target:summaryPalette};canvas.style.cursor="copy";$(".mb-preview-note").textContent="Click the preview to sample a color";});
    savedState.addEventListener("input",()=>{try{const parsed=JSON.parse(savedState.value);if(Array.isArray(parsed.items)){state=migrateLegacyTranslation(node,mergeSavedEnhancerSettings(node,parsed));delete state.autoTranslate;summary.value=getValue(node,"summary","");meta.value=getValue(node,"summary_meta","");sourceSummary=summary.value;sourceMeta=meta.value;summaryPalette=Array.isArray(state.summaryPalette)?state.summaryPalette:[];recentColors=Array.isArray(state.recentColors)?state.recentColors.filter((color)=>/^#[0-9a-f]{6}$/i.test(color)).slice(0,10):[];backgroundOpacity=clampPercent(state.backgroundOpacity);backgroundVisible=state.backgroundVisible!==false;opacitySlider.value=String(backgroundOpacity);updateBackgroundControls();selected=-1;savedState.value=JSON.stringify(state);setValue(node,"editor_state",savedState.value);setValue(node,"prompt_enhancer_settings",JSON.stringify(state.promptEnhancerSettings||{}));refreshTranslationStatus();draw();}}catch{}});
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
      if (typeof echo?.portrait === "boolean") landscapeOrientation = echo.portrait;
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
      state.items = imported.items.map((item) => ({ ...item, bbox: generationBoxToWorkspace(item.bbox || [0,0,1,1]) }));
      state.coordinateSpace = "workspace";
      if (imported.input_hash) state.lastLayoutInputHash = imported.input_hash;
      if (imported.clear_suppression) {
        delete state.suppressLayoutInput;
        delete state.suppressLayoutHash;
      }
      if (imported.suppress_input) {
        state.suppressLayoutInput = true;
        state.suppressLayoutHash = imported.input_hash || state.lastLayoutInputHash || "";
      }
      if (imported.has_summary) {
        summaryPalette = Array.isArray(imported.summary?.palette) ? imported.summary.palette : [];
        summary.value = imported.summary?.caption || "";
        meta.value = Array.isArray(imported.summary?.meta) ? imported.summary.meta.join(", ") : "";
        sourceSummary = summary.value; sourceMeta = meta.value;
        canvasType.value = ["single", "multi_panel", "collage"].includes(imported.summary?.canvas) ? imported.summary.canvas : "";
        if (canvasType.value) state.summaryCanvas = canvasType.value;
        else delete state.summaryCanvas;
      }
      selected = -1;
      saveState();
    };
    const applyBackendReplacement = (output) => {
      const payload = output?.moss_layout_replace ?? output?.ui?.moss_layout_replace;
      const replacement = Array.isArray(payload) ? payload.at(-1) : payload;
      if (!replacement || !Array.isArray(replacement.items)) return;
      if (typeof replacement.summary === "string") summary.value = replacement.summary;
      if (Array.isArray(replacement.meta)) meta.value = replacement.meta.join(", ");
      replacement.items.forEach((fields, outputIndex) => {
        const index = Number.isInteger(fields?.source_index) ? fields.source_index : outputIndex;
        const item = state.items[index];
        if (!item || !fields || typeof fields !== "object") return;
        for (const field of ["caption", "text"]) {
          if (typeof fields[field] !== "string") continue;
          if (field === "text" && !fields[field].trim()) delete item.text;
          else item[field] = fields[field];
        }
        if (Array.isArray(fields.tags)) item.tags = fields.tags;
      });
      sourceSummary = summary.value;
      sourceMeta = meta.value;
      if (replacement.translation_settings) state.translationSettings = replacement.translation_settings;
      saveState();
      renderSidebar();
      draw();
    };
    const onBackendSize = (event) => {
      const eventId = String(event.detail?.nodeId ?? "").split(":").at(-1);
      if (eventId === String(node.id).split(":").at(-1)) applyBackendSize(event.detail?.output);
    };
    window.addEventListener("moss-layout-size", onBackendSize);
    const onBackendLayout = (event) => {
      const eventId = String(event.detail?.nodeId ?? "").split(":").at(-1);
      const output = event.detail?.output;
      if (eventId === String(node.id).split(":").at(-1)) applyBackendLayout(output);
    };
    window.addEventListener("moss-layout-import", onBackendLayout);
    const onBackendReplacement = (event) => {
      const eventId = String(event.detail?.nodeId ?? "").split(":").at(-1);
      const output = event.detail?.output;
      if (eventId === String(node.id).split(":").at(-1)) applyBackendReplacement(output);
    };
    window.addEventListener("moss-layout-replace", onBackendReplacement);
    function restoreConfiguredState() {
      updateDefaultTitle();
      // The DOM editor is created before ComfyUI restores widgets_values.
      // Rebuild it after configure so execution callbacks do not overwrite the
      // restored workflow values with the temporary defaults shown at creation.
      state = readState(node);
      delete state.mossQueuedAction;
      summaryPalette = Array.isArray(state.summaryPalette) ? state.summaryPalette : [];
      recentColors = Array.isArray(state.recentColors) ? state.recentColors.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 10) : [];
      backgroundOpacity = clampPercent(state.backgroundOpacity);
      backgroundVisible = state.backgroundVisible !== false;

      const configuredRatio = getValue(node, "aspect_ratio", "1:1");
      const ratioPart = String(configuredRatio).match(/\d+(?:\.\d+)?:\d+(?:\.\d+)?/)?.[0];
      ratioSelect.value = ratioOptions.includes(configuredRatio) ? configuredRatio : (ratioOptions.includes(ratioPart) ? ratioPart : "Custom");
      landscapeOrientation = state.orientation ? state.orientation === "landscape" : Boolean(getValue(node, "portrait", false));
      state.orientation = landscapeOrientation ? "landscape" : "portrait";
      const configuredResolution = getValue(node, "resolution", "1 MP");
      mpSelect.value = mpOptions.includes(configuredResolution) ? configuredResolution : "1 MP";
      wInput.value = numberFrom(node, "width", 1024);
      hInput.value = numberFrom(node, "height", 1024);
      mpInput.value = numberFrom(node, "megapixels", 1);
      if (mpSelect.value !== "Custom") mpInput.value = parseFloat(mpSelect.value);
      summary.value = getValue(node, "summary", "");
      meta.value = getValue(node, "summary_meta", "");
      sourceSummary = summary.value; sourceMeta = meta.value;
      delete state.autoTranslate;
      canvasType.value = ["single", "multi_panel", "collage"].includes(state.summaryCanvas) ? state.summaryCanvas : "";
      delete state.translated;
      delete state.translationView;
      canvasType.value = ["single", "multi_panel", "collage"].includes(state.summaryCanvas) ? state.summaryCanvas : "";
      updateContextControl();
      opacitySlider.value = String(backgroundOpacity);
      migrateItemsToWorkspace();
      savedState.value = JSON.stringify(state);
      setValue(node, "editor_state", savedState.value);
      selected = -1;
      refreshTranslationStatus();
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
      applyBackendReplacement(output);
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
      window.removeEventListener("moss-layout-replace",onBackendReplacement);
      window.removeEventListener("moss-layout-refresh-background",onBackgroundRefresh);
      window.clearInterval(backgroundRefreshTimer);
      if (node.onConnectionsChange !== previousOnConnectionsChange) node.onConnectionsChange = previousOnConnectionsChange;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (showHelp) showHelp.remove();
      if (activeLayoutDelete === deleteSelectedBox) activeLayoutDelete = null;
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
      return previousOnRemoved?.apply(this, args);
    };

    root.addEventListener("pointerdown",(event)=>{
      const graphPan = event.button === 1 || event.button === 2 || app.canvas?.dragging_canvas || app.canvas?.read_only;
      if (!graphPan) event.stopPropagation();
    });
    root.addEventListener("wheel",(event)=>{
      let element = event.target instanceof Element ? event.target : null;
      while (element && root.contains(element)) {
        const canScrollY = element.scrollHeight > element.clientHeight + 1 &&
          (event.deltaY < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1);
        const canScrollX = element.scrollWidth > element.clientWidth + 1 &&
          (event.deltaX < 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
        if (canScrollY || canScrollX) { event.stopPropagation(); return; }
        element = element.parentElement;
      }
    },{passive:true});
    for(const info of root.querySelectorAll(".mb-info")){
      const show=()=>{if(showHelp)showHelp.remove();const pop=document.createElement("div");pop.className="mb-help-pop";pop.textContent=info.dataset.help;document.body.append(pop);const r=info.getBoundingClientRect();pop.style.left=`${Math.min(innerWidth-270,r.left)}px`;pop.style.top=`${r.bottom+5}px`;showHelp=pop;};
      info.addEventListener("mouseenter",show);info.addEventListener("focus",show);info.addEventListener("mouseleave",()=>{showHelp?.remove();showHelp=null;});info.addEventListener("blur",()=>{showHelp?.remove();showHelp=null;});
    }
    if(ratioSelect.value!=="Custom") { const [initialWidth,initialHeight]=calculatedSize();wInput.value=initialWidth;hInput.value=initialHeight; }
    migrateItemsToWorkspace();
    migrateWorkspaceToSquare();
    savedState.value=JSON.stringify(state);
    syncWidgets();draw();syncConnectedBackground();
  },
  afterConfigureGraph() {
    for (const node of collectNodes(app.graph)) {
      if (NODE_TYPES.has(node.comfyClass) || NODE_TYPES.has(node.type)) {
        node.mossLayoutYdrRestore?.();
      }
    }
  },
});
