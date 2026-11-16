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

Download this repository and copy `ComfyUI-MOSS-Layout-YDR` into `ComfyUI/custom_nodes/`, then restart ComfyUI. Find **MOSS Layout YDR** under **MOSS/Layout**.

Translation is optional. To enable it, install [`requirements-translategemma.txt`](requirements-translategemma.txt) in the same Python environment as ComfyUI, then restart. ComfyUI's existing PyTorch installation is used. TranslateGemma downloads its selected model the first time it runs; translation itself runs locally. Accept the model's terms on Hugging Face before downloading its weights.

## Generate prompt text

Use **Generate** beside Summary, Summary metadata, or a box field to rewrite only that field. Every request receives the complete layout context—summary, metadata, every box's label, coordinates, description, exact text, tags, and palette—so fields stay consistent. A box's own content and coordinates take priority over global text and other boxes, keeping subjects scoped to their intended region. **Generate all** processes the filled summary, metadata, box descriptions, exact visible text, and tags while leaving box geometry and labels untouched. Results replace the edited text in the workflow, just like manual edits.

Connect the same **CLIP** output used by your **Generate Text** node to MOSS Layout YDR's **clip** input, then run the workflow once so the node can keep that encoder available for its in-node Generate buttons. The buttons reuse ComfyUI's native Generate Text engine. Open the single gear button to edit settings shared by every Generate button, including the system prompt; these settings are saved with the workflow. Run text generation while the ComfyUI queue is idle. The cached encoder reference is released when the node is removed or the workflow is run with its CLIP input disconnected.

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

Open **Translate & replace…** in the node's right-hand panel to choose languages and a TranslateGemma model size. Use **Save settings** to configure automatic translation, then enable **Auto on run**. Each workflow run translates the current summary, metadata, and box text and replaces them before outputs are produced. Turn the switch off after a one-time translation if you do not want the current wording translated again on later runs. The **Translate & replace…** button performs the same replacement immediately without queueing image generation. The node does not keep a second hidden copy of the original text, so save a workflow copy first if you need to preserve its original wording.

Translation changes authored prose only; box coordinates, labels, colors, and composition settings stay fixed. Once replaced, translated text is ordinary editable node content and is saved with the workflow. The normal `prompt` and `draft_json` outputs contain the final text.

Translation dependencies are optional and loaded only when requested. Without them, the layout editor and its other features continue to work.

## Credit and license

The visual editor builds on patterns from [Deno2026's ComfyUI custom nodes](https://github.com/Deno2026/comfyui-deno-custom-nodes). Thank you, Deno2026, for sharing this work as open source. This project is licensed under **GPL-3.0-only**; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for notices covering adapted and vendored code.

