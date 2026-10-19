# ComfyUI MOSS Layout YDR

A visual ComfyUI node for composing structured MOSS-Image layout prompts. Draw and edit regions on a resolution-independent board that fits the node, describe the overall image in the side panel, and send a model-ready prompt directly to MOSS.

## Features

- Supports ComfyUI Legacy and Node 2.0 through a frontend DOM widget.
- Fixed-size interactive board with the requested aspect-ratio presets: 1:1, 2:3, 3:4, 3:5, 4:5, 5:7, 5:8, 7:9, 9:16, 9:19, 9:21, and 9:32, plus Custom.
- The orientation control changes the canvas orientation while preserving each box's pixel width, height, and relative position.
- Editable pixel width, height, and megapixel target. Numeric values can be connected from other nodes.
- Drag to create regions; click and drag to move or resize; Ctrl/Command-drag creates overlaps. Double-click opens the region editor. Alt-click cycles overlapping regions.
- Element types: Object, Character, and Text. Every type can include optional exact visible text; Text elements require it. The description stays separate and describes appearance or typography.
- Box captions are drawn on each box; compact boxes use a small attached tag so their captions remain readable. Color palette stripes stay clipped to each box.
- Per-element color palettes and a whole-image palette with an eyedropper for the latest decoded preview. Element colors appear as clipped segmented stripes on their boxes.
- Right-side Summary, Summary metadata, Summary palette, and Elements panels.
- Automatically picks up image-bearing execution previews, live sampler previews, and available decoded-node previews. A connected `background` image takes priority and remains visible while connected. `background_resize` takes priority over presets, sets the ratio from its image, and scales that ratio to the selected megapixels.
- Canvas dimensions are aligned automatically to MOSS-Image's required 16 px grid. Background opacity (0–100%) and visibility are independently controlled; Clear all removes boxes and their fields, clears summary, metadata, canvas hint, and palettes, then resets size controls.
- Optional MOSS JSON or line-based text import.
- Outputs a model-ready MOSS prompt, canvas width and height, editable draft JSON, draft boxes, and elements compatible with ComfyUI's native MOSS layout prompt node.
- The workflow stores the complete editor state, including boxes, box descriptions, palettes, summary fields, sizing choices, and background visibility. State is restored after workflow loading before execution results can update the canvas.

## Install

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI. Find **MOSS Layout YDR** in the **MOSS/Layout** category.

## Node inputs

`layout_text` accepts MOSS draft JSON (`abs` / `xyxy`) and compiled JSON (`abs_centralized` / `yxyx`), including fenced, escaped, and double-encoded JSON, or one item per line (for example, `character: a woman in a red coat`). Compiled coordinates are converted back to the editable top-left canvas using the current width and height. Malformed JSON is reported instead of being misread as a box. After execution, imported boxes, captions, optional exact text, tags, palettes, summary, metadata, canvas hint, and dimensions are loaded into the visual editor. Clear all suppresses the currently connected JSON value until that input changes, so the cleared canvas is not repopulated on the next run. A new JSON value is imported automatically. When an imported draft includes dimensions, the editor adopts its canvas size; a connected megapixel input scales that layout while preserving its ratio. The optional `background` and `background_resize` sockets accept images. Use the optional `input_width`, `input_height`, and `input_megapixels` sockets to drive size from other nodes; their resolved values are reflected in the on-node controls after execution. When both wired dimensions are present they override the on-node ratio and megapixel controls, except that `background_resize` keeps the source image ratio and uses the selected or wired megapixels.

## Connecting to MOSS

Connect `prompt` directly to the MOSS workflow's positive-prompt input, and connect `width` and `height` to the latent or image-generation size controls. The `prompt` output is already compiled for the model: it uses centered `abs_centralized` / `yxyx` boxes and omits the canvas dimensions, which are supplied through the width and height outputs. With no boxes, it outputs the global caption as plain text, matching ComfyUI's built-in MOSS prompt node.

| Output | Connect to | Contents |
| --- | --- | --- |
| `prompt` | MOSS positive prompt | Compiled model-ready prompt; plain caption when there are no boxes |
| `width`, `height` | Latent or MOSS image size | Canvas dimensions in pixels |
| `draft_json` | JSON storage or another layout editor | Editable top-left `abs` / `xyxy` layout draft |
| `bboxes` | Nodes that consume draft items | The draft `items` array |
| `moss_elements` | Native MOSS Layout Prompt `element` | ComfyUI-native 0–1000 element array |
| `summary_caption` | Native MOSS Layout Prompt `prompt` | Global scene description |
| `character_boxes` | Native MOSS Layout Prompt `character_boxes` | One-based indices of character boxes |

If you want to use ComfyUI's built-in **MOSS-Image Layout Prompt** node instead, connect `moss_elements` to `element`, `summary_caption` to `prompt`, `width` and `height` to their matching inputs, and `character_boxes` to `character_boxes`. Connect that node's `prompt` output to the MOSS positive-prompt input. `moss_elements` follows ComfyUI's native box schema (`type`, 0–1000 `[y0,x0,y1,x1]` `bbox`, `desc`, optional `text` and `color_palette`).

The direct `prompt` output is required when you use optional exact text on Object or Character items, item tags, or summary metadata/palette/canvas hints. ComfyUI's built-in prompt builder currently emits only the fields it reads from its native inputs, so those additional draft fields do not all pass through that route.

If boxes must remain exact, turn off the MOSS workflow's prompt upsampler/enhancer. The official ComfyUI bounding-box workflow notes that this step can rewrite the prompt and drop layout instructions.

The `draft_json` output is the editable/importable layout format: `width`, `height`, `bbox_coord_space: "abs"`, `bbox_format: "xyxy"`, `summary`, and a flat `items` array. Its coordinates are absolute pixels from the top-left. `summary.canvas` can be edited in the Canvas structure selector. The item `text` field is optional for objects and characters and required for a Text item; `caption` describes appearance or typography, while `bbox` sets placement. Send `prompt` to MOSS for generation. The `bboxes` output keeps the draft `items` array. See the [MOSS-Image layout reference](https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/references/layout.md), the [official prompt compiler instructions](https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/SKILL.md), and the [ComfyUI MOSS layout prompt implementation](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_moss_image.py).

## Example workflow

Open [`examples/moss-layout-ydr-example.json`](examples/moss-layout-ydr-example.json) in a recent ComfyUI version with MOSS-Image support and this node installed. The workflow was adapted from Comfy-Org's [official MOSS bbox workflow](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_base_t2i_bboxes.json). It connects MOSS Layout YDR's compiled prompt, width, and height directly to the MOSS generation subgraph; the prompt enhancer is disabled so it does not rewrite the box instructions.

The workflow uses [`examples/assets/moss-layout-example.png`](examples/assets/moss-layout-example.png) as an editor background only. Copy that image into `ComfyUI/input` and select it in the Load Image node if ComfyUI cannot resolve the saved filename. The reference image does not condition the generation. Model files required by the official MOSS subgraph are not included. See [`examples/README.md`](examples/README.md) for setup details and attribution.

[`examples/moss-layout-ydr-moss-workflow.json`](examples/moss-layout-ydr-moss-workflow.json) is an additional complete workflow supplied for this release. It includes a saved MOSS Layout YDR node state and can be used to inspect how the editor connects to a MOSS generation graph. It requires the model checkpoints and any custom nodes referenced by that workflow; these are not bundled.

## Acknowledgements

MOSS Layout YDR adapts the visual-editor layout and interaction patterns of [DENO Ideogram Director](https://github.com/Deno2026/comfyui-deno-custom-nodes), including its canvas-based region editing and palette workflow. The MOSS-specific schema, JSON handling, sizing, and ComfyUI integration are tailored for this node. Thanks to Deno2026 and the DENO Custom Nodes contributors for releasing their work as open source.

This project is not affiliated with or endorsed by DENO. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and [LICENSE](LICENSE) for the applicable license. This project is distributed under **GPL-3.0-only**, consistent with the upstream DENO project.

