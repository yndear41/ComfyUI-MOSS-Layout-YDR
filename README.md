# MOSS Layout YDR

A visual layout editor for MOSS-Image in ComfyUI. Draw regions on the image, describe what belongs in each one, and send the finished layout to MOSS.

<p align="center"><img src="examples/assets/moss-layout-example.png" alt="Example MOSS-Image result created with a layout prompt" width="100%"></p>

**Works with both ComfyUI's classic (Legacy) nodes and Node 2.0.** The image above is only a demonstration; the example workflow does not need an image file.

## What it does

- Draw and edit boxes for characters, objects, and text.
- Add descriptions, optional visible text, and color palettes.
- Choose the canvas size in the node or connect width, height, and megapixels from other nodes.
- Import a MOSS layout from JSON or text.
- Save the whole editor state with the workflow, including boxes and fields.
- Generate improved text for individual fields or all filled fields using ComfyUI's local **Generate Text** engine.
- Translate and replace the authored prompt fields inside the node with the locally run TranslateGemma engine.
- Use the latest generated image as a preview, or connect an optional background image.

## Install

Install **MOSS Layout YDR** from ComfyUI Manager or clone this repository into `ComfyUI/custom_nodes/`. Restart ComfyUI and find **MOSS Layout YDR** under **MOSS/Layout**.

Version 0.2 brings the experimental editor into the main package. If you installed the separate Experimental package, disable it before restarting. Saved workflows from either version open with the main package.

Translation is optional. To enable it, install [`requirements-translategemma.txt`](requirements-translategemma.txt) in the same Python environment as ComfyUI, then restart. ComfyUI's existing PyTorch installation is used. TranslateGemma downloads its selected model the first time it runs; translation itself runs locally. Accept the model's terms on Hugging Face before downloading its weights.

## Generate prompt text

Use **Generate** beside Summary, Summary metadata, or a box field to rewrite that field. **Generate all** processes filled text fields. In **Edit**, enter a **Change Request** and optionally specify targets with keywords, **Add Field**, or both. Selecting a box includes all its filled text fields. With no keywords or manual selections, every filled field is selected. Edit remembers the last search terms and change request in the workflow.

Expand **System Prompt (Edit)** inside **Edit** to change the instructions that guide text edits. These are added to the shared system and field prompts for each edit. The override is saved with the workflow, and **Reset to default** restores the built-in instructions. Edit accepts requests in any language and asks the model for the complete updated field in English, including exact visible text.

Connect the same **CLIP** output used by your **Generate Text** node to MOSS Layout YDR's **clip** input. **Generate** and **Edit** submit a ComfyUI text job using the connected CLIP branch. The job can load the encoder on its first run.

The context slider next to the settings gear offers **No context** (target field only), **Summary** (caption and metadata), and **Full layout** (summary and all boxes). **Text Generation Settings** shows the **System Prompt** first, followed by buttons for the shared **Summary**, **Summary Metadata**, **Character BBox**, **Object BBox**, and **Text BBox** prompts. **Generation Settings** includes reasoning, sampling, and an independent **Use tokenizer Jinja template** option. Jinja uses the connected tokenizer's own template when one is available. All these settings are saved with the workflow.

Generate, Edit, and Translate show a progress ring and the current field in the editor. Use the ComfyUI queue controls to cancel a text job.

You can queue more actions while a job is running. Each uses the fields and settings from submission. Results are applied in submission order, and direct edits made while a job is queued are preserved.

### Adjust box geometry

Open **Edit → Box Geometry**, select the boxes to move, resize, or reshape, and describe the change. For example, select the house box and enter *Make the house about the size of a mouse, keeping it on the ground.*

With **Use current background** enabled, a vision-capable CLIP receives the full background with outlines for the selected boxes, plus their coordinates and descriptions. You can also run with coordinates and descriptions alone. The result updates the selected rectangles while preserving their text and colors.

Expand **System Prompt (Box Geometry)** to customize the instructions for spatial edits. The built-in prompt explains the frame, coordinate order, reference outlines, and required JSON response. **Reset to default** restores it.

Starting a normal image-generation workflow only composes and passes the authored prompt. It does not automatically run text generation, editing, or translation inside the node.

Restart ComfyUI after updating. Existing saved workflows are migrated on load to show the new **clip** input and remove obsolete translated output sockets.

## Connect it

For a regular MOSS-Image workflow, connect `prompt` to the positive prompt input and `width` and `height` to the image size inputs.

You can also connect the outputs to ComfyUI's built-in **MOSS-Image Layout Prompt** node:

- `moss_elements` → `element`
- `summary_caption` → `prompt`
- `width` and `height` → the matching size inputs
- `character_boxes` → `character_boxes`

## Example workflow

- [`moss-layout-ydr-moss-workflow.json`](examples/moss-layout-ydr-moss-workflow.json) — the workflow supplied for this project, with its saved MOSS Layout YDR state.

The workflow does not include model checkpoints. Install the models required by your ComfyUI MOSS-Image setup.

## Translate a layout

Use **Translate all** to translate the filled summary, metadata, and box text. The translation icons beside individual fields translate only those fields. Both actions run from the editor and use the shared settings opened by the gear button. Translated text replaces the current wording. The node does not keep a second hidden copy of the original text, so save a workflow copy first if you need to preserve its original wording.

Translation changes authored prose only; box coordinates, labels, colors, and composition settings stay fixed. Once replaced, translated text is ordinary editable node content and is saved with the workflow. The normal `prompt` and `draft_json` outputs contain the final text.

Translation dependencies are optional and loaded only when requested. Without them, the layout editor and its other features continue to work.

## Credit and license

The visual editor builds on patterns from [Deno2026's ComfyUI custom nodes](https://github.com/Deno2026/comfyui-deno-custom-nodes). Thank you, Deno2026, for sharing this work as open source. This project is licensed under **GPL-3.0-only**; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for notices covering adapted and vendored code.

