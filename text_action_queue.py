# SPDX-License-Identifier: GPL-3.0-only
"""ComfyUI output node used only by MOSS Layout YDR's text buttons."""

import json
import logging
import time


class MOSSLayoutTextAction:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"payload": ("STRING",)},
            "optional": {"clip": ("CLIP",)},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    CATEGORY = "MOSS/Layout"
    EXPERIMENTAL = True
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    FUNCTION = "run"

    def run(self, payload, clip=None, unique_id=None):
        from comfy.model_management import throw_exception_if_processing_interrupted as check_interrupt
        from comfy_execution.progress import get_progress_state
        from comfy_execution.utils import get_executing_context
        from server import PromptServer

        if len(payload) > 1_000_000:
            raise ValueError("The text action is too large.")
        action = json.loads(payload)
        if not isinstance(action, dict):
            raise ValueError("Expected a text action object.")

        server = PromptServer.instance
        context = get_executing_context()
        prompt_id = context.prompt_id if context is not None else getattr(server, "last_prompt_id", None)
        last_update = 0.0
        last_value = 0.0

        def report(field_id, index, total, tokens=0, token_limit=0, finished=False):
            nonlocal last_update, last_value
            now = time.monotonic()
            if token_limit and now - last_update < 0.12:
                return
            last_update = now if token_limit else 0.0
            fraction = 1 if finished else max(0, min(0.99, tokens / token_limit)) if token_limit else 0
            value = min(total, max(last_value, index - 1 + fraction))
            last_value = value
            try:
                get_progress_state().update_progress(unique_id, value, total)
            except Exception:
                logging.getLogger(__name__).debug("Could not update the native queue progress", exc_info=True)
            try:
                if prompt_id and server.client_id:
                    progress = {"node": unique_id, "prompt_id": prompt_id, "value": value, "max": total}
                    # rgthree treats each tick after a zero step as a new pass.
                    if value > 0:
                        server.send_sync("progress", progress, server.client_id)
                    server.send_sync("moss_layout_text_progress", {
                        **progress,
                        "field_id": field_id,
                        "index": index, "total": total, "tokens": tokens,
                        "token_limit": token_limit, "finished": finished,
                    }, server.client_id)
            except Exception:
                logging.getLogger(__name__).debug("Could not send the text progress update", exc_info=True)

        check_interrupt()
        segments = action.get("segments")
        settings = action.get("settings", {})
        if action.get("kind") == "geometry":
            from .box_geometry import adjust_boxes

            if clip is None:
                raise ValueError("Connect a CLIP encoder to MOSS Layout YDR.")
            result = adjust_boxes(clip, action, progress=report, interrupt_check=check_interrupt)
        elif action.get("kind") == "translate":
            from .translation_api import translate_segments

            result = translate_segments(segments, settings, progress=report, interrupt_check=check_interrupt)
        elif action.get("kind") in ("generate", "edit"):
            from .prompt_enhancer_api import enhance_segments

            if clip is None:
                raise ValueError("Connect a CLIP encoder to MOSS Layout YDR.")
            result = enhance_segments(
                None, segments, settings, action.get("context"), connected_clip=clip,
                edit_instruction=action.get("edit_instruction"), progress=report,
                interrupt_check=check_interrupt,
            )
        else:
            raise ValueError("Unknown text action.")
        check_interrupt()
        return {"ui": {"moss_text_action": [result]}, "result": ()}
