# Changelog

## 0.2.0

- Bring the experimental editor into the main package. Workflows saved with either node type continue to open.
- Keep the text action buttons available while jobs run. Queue multiple jobs and apply their results in submission order.
- Add AI-assisted box geometry editing with an optional visual reference and a dedicated, editable system prompt.
- Expose a dedicated system prompt for targeted text edits and require English output for Edit.
- Show the active field on the native queue surfaces and the rgthree progress bar.

- Let Edit combine keyword matches and manually selected fields, and select all filled fields when neither is specified.
- Show the System Prompt first and expose the shared Summary, Summary Metadata, and box-type prompts in Text Generation Settings.
- Allow the tokenizer's Jinja chat template on any compatible encoder, with a separate ComfyUI fallback setting.

- Show the current text action and field next to the native ComfyUI queue progress.

- Send text progress to ComfyUI's native progress bar and deliver text results through the execution event, with history as a fallback.

- Queue Generate, Edit, and Translate as separate ComfyUI jobs with progress and cancellation, while keeping the progress ring and current field in the editor.
- Give Generate and Edit private instructions for the target field, including the difference between whole-image metadata tags and the contents of a box.

- Strengthen the built-in system and per-field instructions so Generate and Edit produce a meaningful rewrite, migrate saved copies of the previous built-in system prompt, and keep custom system instructions active even when chat-template rendering is disabled.
- Show whether the connected Qwen 3.5 tokenizer exposes its Jinja template, clarify that only the On/Off reasoning block is controlled by the template, and describe Low/Medium/High as prompt guidance.
- Keep field callbacks attached to the current box after a connected layout is re-imported, report unchanged or missing model results instead of implying that text changed, and surface TranslateGemma's returned error messages instead of inserting them into prompt fields.
- Render box outlines and captions with partial transparency so the preview remains visible beneath them.
- Add in-node prompt enhancement buttons for individual text fields and all filled fields, using ComfyUI's native Generate Text engine.
- Reuse the CLIP model connected to the node through one shared input; keep one generation settings panel and save its settings and system prompt in the workflow without changing box geometry or labels.
- Migrate saved node socket layouts by adding the CLIP input and removing obsolete translated outputs.
- Fix editor scaling in Legacy nodes by removing the fixed DOM-widget size, keeping a shrinkable minimum, and sizing the board to the node after resize; keep the canvas and right-hand panel clipped to the node bounds in both frontends.
- Place Advanced editor state inside the scrollable right panel so it stays aligned with the node edge at different sizes.
- Keep the single maintainer-supplied MOSS workflow as the only example workflow.
- Make Clear all reset every editable layout and prompt field, palettes, canvas hint, and size selection; suppress the current connected JSON until its contents change.
- Import compiled MOSS prompts with centered `yxyx` coordinates by converting them back to the canvas's top-left `xyxy` coordinates.
- Preserve optional exact text on object and character items, expose MOSS `summary.canvas`, and show each box caption clipped within its box.
- Compile the `prompt` output into MOSS's model-facing centered `abs_centralized` / `yxyx` format; retain the editable top-left `abs` / `xyxy` document as `draft_json`.
- Add `moss_elements`, `summary_caption`, and `character_boxes` outputs for direct wiring into ComfyUI's built-in MOSS-Image Layout Prompt node.
- Keep the canvas `width` and `height` as separate outputs for the MOSS generation workflow; when no boxes are present, emit the global caption as the prompt.
- Parse fenced, escaped, double-encoded, and trailing-comma MOSS JSON; report malformed layout JSON instead of silently creating a box from the raw line.
- Apply imported boxes across Legacy and Node 2.0 execution events.
- Import connected MOSS Layout JSON into the visual editor, including boxes, text, summary fields, palettes, optional canvas hints, and dimensions; reflect connected size inputs in the controls after execution.
- Fix workflow restoration so saved boxes, descriptions, palettes, summary fields, sizing controls, and background display settings remain intact after loading and running the node.
- Add **Translate all**, shared translation settings, and per-field translation icons for summary, metadata, box descriptions, exact text, and tags.
- Add keyword-targeted Edit: search Summary, metadata, and boxes, then apply one natural-language change request to the matching fields.
- Vendor the optional TranslateGemma runtime under its MIT license and keep its dependencies lazy-loaded.
- Improve megapixel sizing by selecting dimension pairs aligned to the MOSS 16-pixel multiple.
- Replace prompt text directly after a manual translation; the translated text remains editable and is saved with the workflow.
- Keep the connected CLIP reference alive when ComfyUI rebuilds a node during workflow restoration, and log CLIP cache failures with the affected node ID.
- Clarify that the summary and all bounding-box descriptions are context for the same image during prompt enhancement.
- Add a shared three-position context slider for prompt generation and Edit: target field only, Summary and metadata, or the full layout.
- Add shared Off / Low / Medium / High reasoning guidance for prompt generation and Edit; Off disables thinking, while the other levels guide the model through the prompt.
- Keep the context slider visible beside the generation settings button and replace field translation glyphs with a language-card icon.
- Set fresh text-generation settings to a 1,024-token limit, explain when MTP can help, and report when thinking may have consumed the output budget before a final field was returned.
- Process Translate all and individual field translations sequentially inside the node, and preserve the last Edit search terms and change request in the workflow.
- Keep ordinary image-generation runs from starting text generation or translation inside the node.

## 0.1.0 — Initial release

- Add a visual MOSS-Image layout editor with object, character, and text regions.
- Export schema-aligned layout JSON and width, height, and bounding-box outputs.
- Support ComfyUI Legacy and Node 2.0 frontends.
- Add background preview handling, aspect-ratio and megapixel sizing, color palettes, and text/JSON import.
- Include GPL-3.0-only licensing and attribution for visual-editor patterns shared by Deno2026.
