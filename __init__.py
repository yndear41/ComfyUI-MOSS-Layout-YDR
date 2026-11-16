# SPDX-License-Identifier: GPL-3.0-only
from .moss_layout import MOSSLayoutComposer
from .prompt_enhancer_api import register_routes as register_prompt_enhancer_routes
from .translation_api import register_routes

register_routes()
register_prompt_enhancer_routes()

WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {"MOSSLayoutComposer": MOSSLayoutComposer}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSSLayoutComposer": "MOSS Layout YDR"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
