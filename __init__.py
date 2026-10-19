# SPDX-License-Identifier: GPL-3.0-only
from .moss_layout import MOSSLayoutComposer

WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {"MOSSLayoutComposer": MOSSLayoutComposer}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSSLayoutComposer": "MOSS Layout YDR"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
