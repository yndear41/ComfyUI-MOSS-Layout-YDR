# Example workflows

`moss-layout-ydr-example.json` demonstrates a complete MOSS-Image generation path using the MOSS Layout YDR editor. `moss-layout-ydr-moss-workflow.json` is an additional complete workflow supplied for this release, with a saved editor state.

## Open and run

1. Install this custom node and restart ComfyUI.
2. Make sure your ComfyUI version includes the official MOSS-Image generation nodes and install the model files listed in the workflow's model note.
3. Copy `assets/moss-layout-example.png` into `ComfyUI/input`.
4. Open `moss-layout-ydr-example.json`. If the Load Image node reports a missing image, select `moss-layout-example.png` from the input list.
5. Queue the workflow. The example contains a scene summary and three editable regions: the dancer, the chair, and the galaxy opening.

To inspect the supplied MOSS workflow, open `moss-layout-ydr-moss-workflow.json`. It preserves its saved MOSS Layout YDR state and graph connections. It may require model checkpoints and custom nodes from your ComfyUI installation; those dependencies are not included.

The image is connected to the node's `background` socket for visual reference only. It does not affect model conditioning. MOSS Layout YDR's compiled `prompt`, `width`, and `height` outputs connect directly to the official MOSS generation subgraph. Prompt enhancement is disabled in the example to preserve the explicit box instructions.

The generation subgraph and workflow structure are adapted from Comfy-Org's [official MOSS bbox workflow](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_base_t2i_bboxes.json), under MIT. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the license text. The visual editor patterns are credited to DENO Ideogram Director in the repository's [third-party notices](../THIRD_PARTY_NOTICES.md).
