# Changelog

## Unreleased

- Fix editor scaling in Legacy nodes by removing the fixed DOM-widget size, keeping a shrinkable minimum, and sizing the board to the node after resize; keep the canvas and right-hand panel clipped to the node bounds in both frontends.
- Place Advanced editor state inside the scrollable right panel so it stays aligned with the node edge at different sizes.
- Include the supplied MOSS workflow as a second example.
- Add a runnable MOSS generation workflow example with the supplied reference image, editable layout boxes, and direct prompt/size wiring.
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

## 0.1.0 — Initial release

- Add a visual MOSS-Image layout editor with object, character, and text regions.
- Export schema-aligned layout JSON and width, height, and bounding-box outputs.
- Support ComfyUI Legacy and Node 2.0 frontends.
- Add background preview handling, aspect-ratio and megapixel sizing, color palettes, and text/JSON import.
- Include GPL-3.0-only licensing and attribution for visual-editor patterns shared by Deno2026.

