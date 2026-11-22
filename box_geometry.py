# SPDX-License-Identifier: GPL-3.0-only
"""Run spatial edits using a CLIP text generator and an optional visual reference."""

import base64
import binascii
import io
import json
import re

from .local_text_progress import capture_clip_progress
from .prompt_enhancer_api import _normalize_settings, _render_jinja_prompt


DEFAULT_GEOMETRY_SYSTEM_PROMPT = """You edit the geometry of the selected MOSS-Image bounding boxes. Follow CHANGE REQUEST to move, resize, or reshape those boxes. Keep their IDs and subjects. The description, tags, and visible text identify the subject of each box and provide context.

Use bbox as the starting rectangle. Coordinates are integers on a 0–1000 grid in [left, top, right, bottom] order, starting at the top-left of the generation frame. Use pixel_bbox and the frame dimensions to judge actual sizes and proportions. A square in normalized coordinates may not be square in pixels.

If a reference is attached, it shows the whole background fitted to the generation frame. Match the outline labels to the selected box IDs. Use the image for placement, scale, and relationships. Without a reference, use the starting boxes and their descriptions.

When resizing, preserve the center and proportions unless the request implies a different shape or a fixed anchor such as the ground. Keep the entire rectangle inside the frame. For a relative size, use the scene or another selected box as a reference when available.

Return one JSON object with a boxes array containing every selected ID exactly once, including unchanged rectangles. For example, {"boxes":[{"id":"B1","bbox":[100,200,300,400]}]}. The editor applies only the returned coordinates."""


def _read_reference(value):
    if value is None:
        return None

    from PIL import Image
    import numpy as np
    import torch

    prefix = "data:image/jpeg;base64,"
    if not isinstance(value, str) or not value.startswith(prefix) or len(value) > 900_000:
        raise ValueError("The visual reference must be a JPEG image under 900 KB.")
    try:
        data = base64.b64decode(value[len(prefix):], validate=True)
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "JPEG" or not (1 <= image.width <= 1024 and 1 <= image.height <= 1024):
                raise ValueError("The visual reference must be a JPEG up to 1024 × 1024 pixels.")
            pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    except (binascii.Error, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("Could not read the visual reference image.") from exc
    return torch.from_numpy(pixels).unsqueeze(0)


def _has_image_token(value):
    if isinstance(value, dict):
        if value.get("type") == "image" and value.get("data") is not None:
            return True
        return any(_has_image_token(child) for child in value.values())
    if isinstance(value, (tuple, list)):
        return any(_has_image_token(child) for child in value)
    return False


def _valid_bbox(box, width, height):
    return (
        isinstance(box, list)
        and len(box) == 4
        and all(type(value) is int for value in box)
        and 0 <= box[0] < box[2] <= width
        and 0 <= box[1] < box[3] <= height
    )


def _read_targets(targets, width, height):
    if not isinstance(targets, list) or not targets:
        raise ValueError("Select at least one box.")
    validated = []
    for index, target in enumerate(targets, 1):
        if not isinstance(target, dict) or target.get("id") != f"B{index}":
            raise ValueError("The selected boxes could not be identified.")
        bbox = target.get("bbox")
        pixels = target.get("pixel_bbox")
        if not _valid_bbox(bbox, 1000, 1000) or not _valid_bbox(pixels, width, height):
            raise ValueError("A selected box has invalid coordinates.")
        tags = target.get("tags")
        validated.append({
            "id": target["id"],
            "bbox": bbox,
            "pixel_bbox": pixels,
            "type": str(target.get("type", ""))[:40],
            "description": str(target.get("description", ""))[:3000],
            "visible_text": str(target.get("visible_text", ""))[:1000],
            "tags": [tag[:120] for tag in tags[:20] if isinstance(tag, str)] if isinstance(tags, list) else [],
        })
    return validated


def _read_result(text, expected_ids):
    text = text.rsplit("</think>", 1)[-1].strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
    try:
        parsed = json.loads(fence[1] if fence else text)
    except (TypeError, ValueError) as exc:
        raise ValueError("The model did not return valid box geometry. Try a more specific change request.") from exc
    rows = parsed.get("boxes") if isinstance(parsed, dict) else None
    if not isinstance(rows, list):
        raise ValueError("The model did not return a boxes list.")
    values = {}
    for row in rows:
        identifier = row.get("id") if isinstance(row, dict) else None
        if not isinstance(identifier, str) or identifier not in expected_ids or identifier in values:
            raise ValueError("The model returned an unknown or duplicate box.")
        bbox = row.get("bbox")
        if not _valid_bbox(bbox, 1000, 1000):
            raise ValueError(f"The model returned invalid coordinates for {identifier}.")
        values[identifier] = bbox
    if values.keys() != expected_ids:
        raise ValueError("The model did not return every selected box.")
    return values


def adjust_boxes(clip, action, *, progress, interrupt_check):
    width, height = action.get("width"), action.get("height")
    if any(type(size) is not int or not 1 <= size <= 65536 for size in (width, height)):
        raise ValueError("Invalid generation dimensions.")
    targets = _read_targets(action.get("boxes"), width, height)
    instruction = action.get("instruction")
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 6000:
        raise ValueError("Enter a change request of at most 6,000 characters.")
    settings = _normalize_settings(action.get("settings"))
    system_prompt = settings["geometry_system_prompt"] or DEFAULT_GEOMETRY_SYSTEM_PROMPT
    progress("geometry", 1, 1)
    interrupt_check()
    image = _read_reference(action.get("image"))
    reference = (
        "The attached image shows the entire current background fitted within the generation frame. "
        "The labeled rectangles mark exactly the selected boxes. Use the scene for relative scale and composition."
        if image is not None else
        "There is no attached image. Use the existing boxes, descriptions, and canvas dimensions for scale."
    )
    prompt = (
        f"{reference}\n"
        f"The generation frame is {width} by {height} pixels. "
        "Return a single JSON object with one entry for each selected ID, using integer "
        "[left, top, right, bottom] coordinates from 0 to 1000 within the generation frame. "
        'Use this structure: {"boxes":[{"id":"B1","bbox":[100,200,300,400]}]}.\n\n'
        f"SELECTED BOXES:\n{json.dumps(targets, ensure_ascii=False)}\n\n"
        f"CHANGE REQUEST:\n{instruction.strip()}"
    )
    formatted = None
    if image is None and settings["use_jinja_template"]:
        formatted = _render_jinja_prompt(clip, prompt, system_prompt, False)
    native_template = image is not None or (formatted is None and settings["use_default_template"])
    if native_template:
        formatted = prompt
    elif formatted is None:
        formatted = f"{system_prompt}\n\n{prompt}"

    # The native multimodal template inserts the actual image token. A
    # text-only pre-rendered chat template can silently drop the image.
    tokens = clip.tokenize(
        formatted, image=image, images=[], skip_template=not native_template,
        min_length=1, thinking=False, system_prompt=system_prompt if native_template else "",
    )
    if image is not None and not _has_image_token(tokens):
        raise ValueError("The connected CLIP did not accept the background. Use a vision-capable encoder or turn off Use current background.")
    interrupt_check()
    max_length = min(settings["max_length"], max(192, 112 + 55 * len(targets)))
    if max_length < 32 + 28 * len(targets):
        raise ValueError("Increase Maximum output tokens in Text Generation Settings for this selection.")

    def on_tokens(value, total):
        interrupt_check()
        progress("geometry", 1, 1, int(value), int(total or max_length))

    with capture_clip_progress(on_tokens, preserve_interrupt=True):
        generated = clip.generate(tokens, max_length=max_length, do_sample=False, seed=settings["seed"], mtp=False)
    interrupt_check()
    expected_ids = {target["id"] for target in targets}
    values = _read_result(clip.decode(generated), expected_ids)
    progress("geometry", 1, 1, finished=True)
    return {"status": "ready", "values": values}
