# SPDX-License-Identifier: GPL-3.0-only
from .moss_layout import MOSSLayoutComposer
from .prompt_enhancer_api import register_routes as register_prompt_enhancer_routes
from .text_action_queue import MOSSLayoutTextAction
from .translation_api import register_routes

register_routes()
register_prompt_enhancer_routes()

WEB_DIRECTORY = "./js"


class LegacyExperimentalLayout(MOSSLayoutComposer):
    DEPRECATED = True


NODE_CLASS_MAPPINGS = {
    "MOSSLayoutComposer": MOSSLayoutComposer,
    "MOSSLayoutComposerExperimental": LegacyExperimentalLayout,
    "MOSSLayoutTextAction": MOSSLayoutTextAction,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MOSSLayoutComposer": "MOSS Layout YDR",
    "MOSSLayoutComposerExperimental": "MOSS Layout YDR",
    "MOSSLayoutTextAction": "MOSS Layout YDR Text Action",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
