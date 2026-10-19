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
- Use the latest generated image as a preview, or connect an optional background image.

## Install

Download this repository and copy `ComfyUI-MOSS-Layout-YDR` into `ComfyUI/custom_nodes/`, then restart ComfyUI. Find **MOSS Layout YDR** under **MOSS/Layout**.

## Connect it

For a regular MOSS-Image workflow, connect `prompt` to the positive prompt input and `width` and `height` to the image size inputs.

You can also connect the outputs to ComfyUI's built-in **MOSS-Image Layout Prompt** node:

- `moss_elements` → `element`
- `summary_caption` → `prompt`
- `width` and `height` → the matching size inputs
- `character_boxes` → `character_boxes`

## Example workflows

- [`moss-layout-ydr-example.json`](examples/moss-layout-ydr-example.json) — a ready-to-open example with a saved layout.
- [`moss-layout-ydr-moss-workflow.json`](examples/moss-layout-ydr-moss-workflow.json) — an additional MOSS workflow.

The workflows do not include model checkpoints. Install the models required by your ComfyUI MOSS-Image setup.

## Credit and license

The visual editor builds on patterns from [Deno2026's ComfyUI custom nodes](https://github.com/Deno2026/comfyui-deno-custom-nodes). Thank you, Deno2026, for sharing this work as open source. This project is licensed under **GPL-3.0-only**; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

