# SPDX-License-Identifier: GPL-3.0-only
"""ComfyUI node for visually composing MOSS-Image Layout prompts."""
import json
import hashlib
import math
import os
import uuid


ASPECTS = {
    "1:1": (1, 1), "2:3": (2, 3), "3:4": (3, 4), "3:5": (3, 5),
    "4:5": (4, 5), "5:7": (5, 7), "5:8": (5, 8), "7:9": (7, 9),
    "9:16": (9, 16), "9:19": (9, 19), "9:21": (9, 21), "9:32": (9, 32),
    "Custom": None,
}
LEGACY_ASPECTS = {
    "1:1 (Square)": (1, 1), "5:4 (Classic Photo)": (5, 4), "4:3 (Classic TV)": (4, 3),
    "7:5 (Photo)": (7, 5), "3:2 (Photography)": (3, 2), "16:10 (Widescreen)": (16, 10),
    "5:3 (Wide Photo)": (5, 3), "16:9 (Landscape)": (16, 9), "1.85:1 (Cinema)": (185, 100),
    "2:1 (Panorama)": (2, 1), "2.2:1 (CinemaScope)": (220, 100),
    "2.35:1 (Anamorphic)": (235, 100), "2.39:1 (Cinema)": (239, 100), "21:9 (Ultrawide)": (21, 9),
}
RESOLUTIONS = ["0.5 MP", "0.75 MP", "1 MP", "1.25 MP", "1.5 MP", "2 MP",
               "2.5 MP", "3 MP", "4 MP", "6 MP", "8 MP", "Custom"]
DIMENSION_MULTIPLES = ["8", "16", "32", "64"]  # Hidden legacy widget retained for workflow compatibility.
DIMENSION_QUANTUM = 16


def _snap_dimension(value, quantum, round_down=False):
    scaled = float(value) / quantum
    units = math.floor(scaled) if round_down else math.floor(scaled + 0.5)
    return max(64, int(units) * quantum)


def _fit_dimensions(ratio, area, quantum=DIMENSION_QUANTUM, round_down=False):
    """Choose aligned dimensions that keep the requested ratio with low area drift."""
    ratio = max(1e-9, float(ratio))
    area = max(4096.0, float(area))
    ideal_width = math.sqrt(area * ratio)
    ideal_height = math.sqrt(area / ratio)
    center_width = ideal_width / quantum
    center_height = ideal_height / quantum
    max_units = 65536 // quantum
    width_units = range(max(4, math.floor(center_width) - 8), min(max_units, math.ceil(center_width) + 8) + 1)
    candidates = []
    for width_unit in width_units:
        width = width_unit * quantum
        height_units = set()
        for center in (width_unit / ratio, area / (quantum * quantum * width_unit), center_height):
            height_units.update(range(max(4, math.floor(center) - 3), min(max_units, math.ceil(center) + 3) + 1))
        for height_unit in height_units:
            height = height_unit * quantum
            candidate_area = width * height
            if round_down and candidate_area > area:
                continue
            ratio_error = abs((width / height) / ratio - 1.0)
            area_error = abs(candidate_area / area - 1.0)
            candidates.append((area_error + 2.0 * ratio_error, ratio_error, area_error, -candidate_area, width, height))
    if not candidates:
        return _snap_dimension(ideal_width, quantum, True), _snap_dimension(ideal_height, quantum, True)
    best = min(candidates)
    return best[-2], best[-1]


def _target_megapixels(resolution, megapixels, input_megapixels=None):
    if input_megapixels is not None:
        try:
            wired = float(input_megapixels)
            if wired > 0:
                return max(0.25, min(16.0, wired))
        except (TypeError, ValueError):
            pass
    if resolution == "Custom":
        try:
            return max(0.25, min(16.0, float(megapixels)))
        except (TypeError, ValueError):
            return 1.0
    try:
        return max(0.25, min(16.0, float(str(resolution).split()[0])))
    except (TypeError, ValueError):
        return 1.0


def calculate_size(aspect_ratio, resolution, width, height, megapixels, portrait,
                   dimension_multiple=16, input_megapixels=None, round_down=False):
    quantum = DIMENSION_QUANTUM
    mp = _target_megapixels(resolution, megapixels, input_megapixels)
    if aspect_ratio == "Custom":
        rw, rh = max(1, float(width)), max(1, float(height))
        scale = math.sqrt(mp * 1_000_000 / (rw * rh))
        w, h = rw * scale, rh * scale
    else:
        rw, rh = ASPECTS.get(aspect_ratio, LEGACY_ASPECTS.get(aspect_ratio, (1, 1)))
        if portrait:
            rw, rh = rh, rw
        area = mp * 1_000_000
        scale = math.sqrt(area / (rw * rh))
        w, h = rw * scale, rh * scale
    return _fit_dimensions(w / h, mp * 1_000_000, quantum, round_down)


def _external_size(aspect_ratio, width, height, input_width, input_height, quantum, portrait=False):
    """Resolve wired size controls while preserving the chosen aspect when only one is wired."""
    try:
        wired_width = float(input_width) if input_width is not None else None
        if wired_width is not None and wired_width <= 0:
            wired_width = None
    except (TypeError, ValueError):
        wired_width = None
    try:
        wired_height = float(input_height) if input_height is not None else None
        if wired_height is not None and wired_height <= 0:
            wired_height = None
    except (TypeError, ValueError):
        wired_height = None
    if wired_width is None and wired_height is None:
        return None
    if aspect_ratio == "Custom":
        ratio = max(1, float(width)) / max(1, float(height))
    else:
        rw, rh = ASPECTS.get(aspect_ratio, LEGACY_ASPECTS.get(aspect_ratio, (1, 1)))
        ratio = rw / rh
        if portrait:
            ratio = 1 / ratio
    out_width = wired_width if wired_width is not None else wired_height * ratio
    out_height = wired_height if wired_height is not None else wired_width / ratio
    if wired_width is not None and wired_height is not None:
        out_width, out_height = wired_width, wired_height
    return _snap_dimension(out_width, quantum), _snap_dimension(out_height, quantum)


def _positive_dimension(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0 or value > 65536:
        return None
    return int(round(value))


def _strip_json_trailing_commas(value):
    """Remove commas immediately before a closing JSON object or array."""
    output = []
    in_string = False
    escaped = False
    index = 0
    while index < len(value):
        char = value[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
            output.append(char)
        elif char == ",":
            lookahead = index + 1
            while lookahead < len(value) and value[lookahead].isspace():
                lookahead += 1
            if lookahead >= len(value) or value[lookahead] not in "]}":
                output.append(char)
        else:
            output.append(char)
        index += 1
    return "".join(output)


def _json_variants(value):
    variants = [value]
    unescaped_quotes = value.replace('\\"', '"')
    if unescaped_quotes != value:
        variants.append(unescaped_quotes)
    for candidate in tuple(variants):
        without_trailing_commas = _strip_json_trailing_commas(candidate)
        if without_trailing_commas != candidate:
            variants.append(without_trailing_commas)
    return variants


def _decode_json_candidate(value):
    """Decode ordinary, escaped, fenced-inner, and double-encoded JSON."""
    pending = _json_variants(value)
    attempted = set()
    while pending:
        candidate = pending.pop(0)
        if candidate in attempted:
            continue
        attempted.add(candidate)
        try:
            decoded = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(decoded, str):
            pending.extend(_json_variants(decoded))
        else:
            return decoded
    return None


def parse_layout_text(value):
    """Read MOSS layout JSON, including fenced, escaped, and double-encoded JSON."""
    if not isinstance(value, str) or not value.strip():
        return {}, False
    text = value.strip().lstrip("\ufeff")
    if text.startswith("```"):
        fence_lines = text.splitlines()
        if fence_lines and fence_lines[0].lstrip().startswith("```"):
            fence_lines = fence_lines[1:]
        if fence_lines and fence_lines[-1].strip().startswith("```"):
            fence_lines = fence_lines[:-1]
        text = "\n".join(fence_lines).strip()
    source = None
    candidates = [text]
    first, last = text.find("{"), text.rfind("}")
    if first >= 0 and last > first and text[first:last + 1] != text:
        candidates.append(text[first:last + 1])
    for candidate in candidates:
        source = _decode_json_candidate(candidate)
        if source is not None:
            break
    if isinstance(source, dict):
        # Accept a common wrapper while keeping the MOSS schema itself flat.
        for key in ("layout", "moss_layout", "data"):
            nested = source.get(key)
            if isinstance(nested, dict) and ("items" in nested or "summary" in nested):
                source = nested
                break
        if "items" in source or "summary" in source:
            return source, True
    if first >= 0 and last > first:
        raise ValueError(
            "layout_text contains a JSON-like object that could not be read as a MOSS layout. "
            "Check the input JSON, then connect or paste it again; it will not be converted into a box."
        )

    # Keep the small convenience format supported by early node versions.
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if not lines:
        return {}, False
    return {"items": [
        {"label": "character" if line.lower().startswith("character:") else "object",
         "caption": line.split(":", 1)[-1].strip(),
         "bbox": [0.1, 0.08 + i * 0.08, 0.9, min(0.96, 0.48 + i * 0.08)]}
        for i, line in enumerate(lines)
    ]}, False


def normalize_items(source, width, height, source_width=None, source_height=None,
                    bbox_coord_space="abs", bbox_format="xyxy", include_source_indices=False):
    raw_items = source.get("items", []) if isinstance(source, dict) else []
    if not isinstance(raw_items, list):
        return []
    items = []
    for source_index, entry in enumerate(raw_items):
        if not isinstance(entry, dict):
            continue
        label = entry.get("label", "object")
        if label not in ("object", "character", "text"):
            label = "object"
        raw_caption = entry.get("caption", "")
        caption = str(raw_caption).strip() if raw_caption is not None else ""
        if not caption:
            continue
        try:
            coordinates = [float(value) for value in entry.get("bbox", [])]
        except (TypeError, ValueError):
            continue
        if len(coordinates) != 4 or not all(math.isfinite(value) for value in coordinates):
            continue

        # MOSS compiled prompts use centered [y1, x1, y2, x2] coordinates.
        if bbox_coord_space == "abs_centralized" or bbox_format == "yxyx":
            y1, x1, y2, x2 = coordinates
            canvas_width = source_width or width
            canvas_height = source_height or height
            if bbox_coord_space == "abs_centralized":
                x1, x2 = x1 + canvas_width / 2, x2 + canvas_width / 2
                y1, y2 = y1 + canvas_height / 2, y2 + canvas_height / 2
            if source_width and source_height:
                x1, x2 = x1 * width / source_width, x2 * width / source_width
                y1, y2 = y1 * height / source_height, y2 * height / source_height
        else:
            x1, y1, x2, y2 = coordinates
            # The editor and line-based convenience input store canvas fractions.
            if max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.001:
                x1, x2, y1, y2 = x1 * width, x2 * width, y1 * height, y2 * height
            else:
                source_width = source_width or width
                source_height = source_height or height
                x1, x2 = x1 * width / source_width, x2 * width / source_width
                y1, y2 = y1 * height / source_height, y2 * height / source_height
        x1, x2 = sorted((max(0, min(width, x1)), max(0, min(width, x2))))
        y1, y2 = sorted((max(0, min(height, y1)), max(0, min(height, y2))))
        if x2 <= x1 or y2 <= y1:
            continue
        item = {"label": label, "caption": caption,
                "bbox": [int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2))]}
        if include_source_indices:
            item["_source_index"] = source_index
        exact_text = entry.get("text")
        if exact_text is not None:
            exact_text = str(exact_text)
            if exact_text.strip():
                item["text"] = exact_text
        if label == "text":
            if not item.get("text", "").strip():
                continue
        for key in ("tags", "palette"):
            if isinstance(entry.get(key), list):
                values = [value for value in entry[key] if isinstance(value, str) and value.strip()]
                if values:
                    item[key] = values
        items.append(item)
    return items


def _layout_signature(value):
    """Return a stable signature for a connected layout input."""
    if not isinstance(value, str) or not value.strip():
        return ""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def compile_moss_prompt(document):
    """Convert the editor's top-left xyxy draft into MOSS model-facing JSON."""
    summary = document["summary"]
    items = document["items"]
    if not items:
        # Match ComfyUI's native MOSS layout prompt node: no boxes means a caption prompt.
        return summary["caption"]

    width, height = document["width"], document["height"]
    compiled_items = []
    for item in items:
        x1, y1, x2, y2 = item["bbox"]
        compiled = {
            key: value for key, value in item.items() if key != "bbox"
        }
        # MOSS model prompts use centered, integer [y1, x1, y2, x2] coordinates.
        compiled["bbox"] = [y1 - height // 2, x1 - width // 2,
                            y2 - height // 2, x2 - width // 2]
        compiled_items.append(compiled)

    prompt = {
        "summary": summary,
        "items": compiled_items,
        "bbox_coord_space": "abs_centralized",
        "bbox_format": "yxyx",
    }
    return json.dumps(prompt, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def build_moss_elements(items, width, height):
    """Build the ARRAY schema consumed by ComfyUI's native MOSS layout prompt node."""
    elements = []
    character_indices = []
    for index, item in enumerate(items, start=1):
        x1, y1, x2, y2 = item["bbox"]
        element = {
            "type": "text" if item["label"] == "text" else "obj",
            # Native ComfyUI boxes use 0..1000 [y0, x0, y1, x1] coordinates.
            "bbox": [
                round(y1 * 1000 / height, 6),
                round(x1 * 1000 / width, 6),
                round(y2 * 1000 / height, 6),
                round(x2 * 1000 / width, 6),
            ],
            "desc": item["caption"],
        }
        if item.get("text"):
            element["text"] = item["text"]
        if item.get("palette"):
            element["color_palette"] = item["palette"]
        elements.append(element)
        if item["label"] == "character":
            character_indices.append(str(index))
    return elements, ", ".join(character_indices)


def _translation_segments(summary_caption, meta, items):
    segments = []
    if isinstance(summary_caption, str) and summary_caption.strip():
        segments.append({"id": "summary.caption", "text": summary_caption})
    for index, value in enumerate(meta if isinstance(meta, list) else []):
        if isinstance(value, str) and value.strip():
            segments.append({"id": f"summary.meta.{index}", "text": value})
    for index, item in enumerate(items if isinstance(items, list) else []):
        if not isinstance(item, dict):
            continue
        for field in ("caption", "text"):
            value = item.get(field)
            if isinstance(value, str) and value.strip():
                segments.append({"id": f"item.{index}.{field}", "text": value.strip() if field == "caption" else value})
        tags = item.get("tags", [])
        if isinstance(tags, list):
            for tag_index, value in enumerate(tags):
                if isinstance(value, str) and value.strip():
                    segments.append({"id": f"item.{index}.tags.{tag_index}", "text": value})
    return segments


def _apply_translated_values(document, translated_state, summary_caption, meta,
                             source_items=None, compiled_source_indices=None):
    if not isinstance(translated_state, dict) or translated_state.get("status") != "ready":
        return None
    values = translated_state.get("values")
    settings = translated_state.get("settings")
    if not isinstance(values, dict) or not isinstance(settings, dict):
        return None
    try:
        from .translation_api import source_key
        text_items = source_items if isinstance(source_items, list) else document.get("items", [])
        current_key = source_key(_translation_segments(summary_caption, meta, text_items), settings)
    except Exception:
        return None
    if current_key != translated_state.get("source_key"):
        return None
    translated_document = json.loads(json.dumps(document, ensure_ascii=False))
    summary = translated_document.get("summary", {})
    value = values.get("summary.caption")
    if isinstance(value, str):
        summary["caption"] = value
    meta_override = values.get("summary.meta_override")
    if isinstance(meta_override, str):
        summary["meta"] = [part.strip() for part in meta_override.split(",") if part.strip()]
    elif isinstance(meta_override, list) and all(isinstance(entry, str) for entry in meta_override):
        summary["meta"] = meta_override
    else:
        for index, original in enumerate(meta):
            value = values.get(f"summary.meta.{index}")
            if isinstance(value, str):
                translated_meta = summary.setdefault("meta", list(meta))
                if index < len(translated_meta):
                    translated_meta[index] = value
    for index, item in enumerate(translated_document.get("items", [])):
        source_index = compiled_source_indices[index] if compiled_source_indices and index < len(compiled_source_indices) else index
        for field in ("caption", "text"):
            value = values.get(f"item.{source_index}.{field}")
            if isinstance(value, str):
                if field == "text" and not value.strip():
                    item.pop(field, None)
                    continue
                item[field] = value
        tags = item.get("tags")
        tags_override = values.get(f"item.{source_index}.tags_override")
        if isinstance(tags_override, list) and all(isinstance(entry, str) for entry in tags_override):
            if tags_override:
                item["tags"] = tags_override
            else:
                item.pop("tags", None)
        elif isinstance(tags, list):
            for tag_index in range(len(tags)):
                value = values.get(f"item.{source_index}.tags.{tag_index}")
                if isinstance(value, str):
                    tags[tag_index] = value
    return translated_document


class MOSSLayoutComposer:
    @classmethod
    def INPUT_TYPES(cls):
        socketless = {"socketless": True}
        return {
            "required": {
                "summary": ("STRING", {"multiline": True, "default": "", "tooltip": "Describe the full image: scene, composition, lighting, style, and relationships between elements.", **socketless}),
                "aspect_ratio": (list(ASPECTS.keys()), {"tooltip": "Choose the proportions of the layout board. Select Custom to enter an exact width and height.", **socketless}),
                "width": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16, "tooltip": "Target canvas width in pixels. Editing width or height switches the ratio to Custom.", **socketless}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16, "tooltip": "Target canvas height in pixels. Editing width or height switches the ratio to Custom.", **socketless}),
                "resolution": (RESOLUTIONS, {"tooltip": "Choose a target image area in megapixels. Custom enables the editable MP field.", **socketless}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 16.0, "step": 0.05, "tooltip": "Target image area in megapixels. The MOSS-safe minimum dimension multiple is 16.", **socketless}),
                "dimension_multiple": (DIMENSION_MULTIPLES, {"default": "16", "tooltip": "Legacy workflow compatibility field. The value is ignored; dimensions are aligned automatically to 16 px.", **socketless}),
                "portrait": ("BOOLEAN", {"default": False, "tooltip": "Internal orientation state controlled by the swap button.", **socketless}),
                "editor_state": ("STRING", {"multiline": True, "default": "{}", "tooltip": "Saved box editor data. It is tucked under Advanced and normally does not need editing.", **socketless}),
                "prompt_enhancer_settings": ("STRING", {"multiline": True, "default": "{}", "tooltip": "Saved settings for the in-node text generator.", **socketless}),
            },
            "optional": {
                "layout_text": ("STRING", {"forceInput": True, "multiline": True, "tooltip": "Import a MOSS layout JSON string or one item per line."}),
                "background": ("IMAGE", {"tooltip": "Optional board image. It replaces the automatic preview while connected."}),
                "background_resize": ("IMAGE", {"tooltip": "Optional board image. It replaces the automatic preview and sets the custom aspect ratio; megapixels scale its size."}),
                "summary_meta": ("STRING", {"multiline": True, "default": "", "tooltip": "Optional comma-separated medium or genre tags written to summary.meta.", **socketless}),
                "input_width": ("INT", {"forceInput": True, "tooltip": "Optional wired width override. When only one dimension is connected, the selected aspect ratio supplies the other."}),
                "input_height": ("INT", {"forceInput": True, "tooltip": "Optional wired height override. When only one dimension is connected, the selected aspect ratio supplies the other."}),
                "input_megapixels": ("FLOAT", {"forceInput": True, "tooltip": "Optional wired megapixel override. Background Resize keeps its source ratio and scales to this area."}),
                "clip": ("CLIP", {"tooltip": "Connect the same CLIP encoder used by Generate Text. This model powers the in-node Generate buttons."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING", "INT", "INT", "ARRAY", "STRING", "ARRAY", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "width", "height", "bboxes", "draft_json",
                    "moss_elements", "summary_caption", "character_boxes")
    FUNCTION = "compose"
    CATEGORY = "MOSS/Layout"

    def compose(self, summary, aspect_ratio, width, height, resolution, megapixels, portrait,
                dimension_multiple="16", editor_state="{}", layout_text=None,
                background=None, background_resize=None, summary_meta="", input_width=None,
                input_height=None, input_megapixels=None, clip=None, unique_id=None,
                prompt_enhancer_settings="{}", **_legacy_inputs):
        try:
            from .prompt_enhancer_api import cache_connected_clip
            cache_connected_clip(unique_id, clip)
        except Exception as exc:
            print(f"[MOSS Layout YDR] Could not cache the connected CLIP for node {unique_id!r}: {exc}")
        quantum = DIMENSION_QUANTUM
        resizing_background = background_resize is not None
        if background_resize is not None:
            height, width = int(background_resize.shape[1]), int(background_resize.shape[2])
            aspect_ratio = "Custom"
        try:
            saved_editor_state = json.loads(editor_state or "{}")
        except (json.JSONDecodeError, TypeError):
            saved_editor_state = {}
        if not isinstance(saved_editor_state, dict):
            saved_editor_state = {}
        layout_input_hash = _layout_signature(layout_text)
        layout_input_suppressed = bool(
            layout_input_hash
            and saved_editor_state.get("suppressLayoutInput")
            and (
                not saved_editor_state.get("suppressLayoutHash")
                or saved_editor_state.get("suppressLayoutHash") == layout_input_hash
            )
        )
        layout_input_active = bool(layout_input_hash) and not layout_input_suppressed
        if layout_input_active:
            source, imported_layout = parse_layout_text(layout_text)
        else:
            source, imported_layout = saved_editor_state, False
        source_summary = source.get("summary", {}) if isinstance(source, dict) else {}
        if isinstance(source_summary, str):
            source_summary = {"caption": source_summary}
        if not isinstance(source_summary, dict):
            source_summary = {}
        source_width = _positive_dimension(source.get("width")) if isinstance(source, dict) else None
        source_height = _positive_dimension(source.get("height")) if isinstance(source, dict) else None
        imported_dimensions = bool(imported_layout and source_width and source_height)

        # A complete MOSS layout carries its own canvas ratio and dimensions.
        # Image and wired dimensions keep their existing priority; a wired MP
        # scales the imported ratio while preserving the layout geometry.
        use_layout_canvas = imported_dimensions and not resizing_background
        size_aspect = "Custom" if use_layout_canvas else aspect_ratio
        size_width = source_width if use_layout_canvas else width
        size_height = source_height if use_layout_canvas else height
        if use_layout_canvas:
            aspect_ratio = "Custom"
        wired_size = None if resizing_background else _external_size(
            size_aspect, size_width, size_height, input_width, input_height, quantum,
            portrait=portrait,
        )
        if wired_size is not None:
            width, height = wired_size
        elif use_layout_canvas and input_megapixels is None:
            width = _snap_dimension(source_width, quantum)
            height = _snap_dimension(source_height, quantum)
            resolution = "Custom"
            megapixels = width * height / 1_000_000
        else:
            width, height = calculate_size(
                size_aspect, resolution, size_width, size_height, megapixels, portrait,
                input_megapixels=input_megapixels,
                round_down=resizing_background,
            )

        normalize_source = source
        if not imported_layout and isinstance(source, dict) and source.get("coordinateSpace") == "workspace":
            # Editor boxes use stable normalized coordinates over the full working
            # field. Crop that field to MOSS's selected generation aspect only at
            # serialization time so changing the aspect never moves the boxes.
            normalize_source = dict(source)
            raw_items = source.get("items", [])
            try:
                workspace_aspect = float(source.get("workspaceAspect", 1.0))
            except (TypeError, ValueError):
                workspace_aspect = 1.0
            if not math.isfinite(workspace_aspect) or workspace_aspect <= 0:
                workspace_aspect = 1.0
            target_aspect = width / height
            relative_aspect = target_aspect / workspace_aspect
            if relative_aspect >= 1:
                frame_width, frame_height = 1.0, 1.0 / relative_aspect
            else:
                frame_width, frame_height = relative_aspect, 1.0
            frame_left, frame_top = (1.0 - frame_width) / 2, (1.0 - frame_height) / 2
            mapped_items = []
            if isinstance(raw_items, list):
                for entry in raw_items:
                    if not isinstance(entry, dict):
                        continue
                    mapped = dict(entry)
                    try:
                        x1, y1, x2, y2 = [float(value) for value in entry.get("bbox", [])]
                    except (TypeError, ValueError):
                        mapped_items.append(mapped)
                        continue
                    mapped["bbox"] = [
                        max(0.0, min(1.0, (x1 - frame_left) / frame_width)),
                        max(0.0, min(1.0, (y1 - frame_top) / frame_height)),
                        max(0.0, min(1.0, (x2 - frame_left) / frame_width)),
                        max(0.0, min(1.0, (y2 - frame_top) / frame_height)),
                    ]
                    mapped_items.append(mapped)
            normalize_source["items"] = mapped_items

        indexed_items = normalize_items(
            normalize_source, width, height,
            source_width=source_width if imported_layout else None,
            source_height=source_height if imported_layout else None,
            bbox_coord_space=source.get("bbox_coord_space", "abs") if isinstance(source, dict) else "abs",
            bbox_format=source.get("bbox_format", "xyxy") if isinstance(source, dict) else "xyxy",
            include_source_indices=True,
        )
        source_item_indices = [item.pop("_source_index") for item in indexed_items]
        items = indexed_items
        imported_summary = imported_layout and "summary" in source
        if imported_summary:
            summary_caption = str(source_summary.get("caption", "")).strip() or (summary or "").strip()
            raw_meta = source_summary.get("meta", [])
            meta = [str(part).strip() for part in raw_meta if part is not None and str(part).strip()] if isinstance(raw_meta, list) else [part.strip() for part in str(raw_meta).split(",") if part.strip()]
            raw_summary_palette = source_summary.get("palette", [])
            summary_palette = [str(color).strip() for color in raw_summary_palette if color is not None and str(color).strip()] if isinstance(raw_summary_palette, list) else []
            summary_canvas = source_summary.get("canvas")
        else:
            summary_caption = (summary or "").strip()
            meta = [part.strip() for part in (summary_meta or "").split(",") if part.strip()]
            summary_palette = source.get("summaryPalette", []) if isinstance(source, dict) else []
            summary_canvas = source.get("summaryCanvas") if isinstance(source, dict) else None
            summary_palette = [str(color).strip() for color in summary_palette if str(color).strip()] if isinstance(summary_palette, list) else []
        summary_object = {"caption": summary_caption or "A coherent image composition."}
        if meta:
            summary_object["meta"] = meta
        if summary_palette:
            summary_object["palette"] = summary_palette
        if isinstance(summary_canvas, str) and summary_canvas in {"single", "multi_panel", "collage"}:
            summary_object["canvas"] = summary_canvas
        document = {
            "width": width,
            "height": height,
            "bbox_coord_space": "abs",
            "bbox_format": "xyxy",
            "summary": summary_object,
            "items": items,
        }
        # A connected layout is normalized into the same compact item array the
        # editor displays, so translation IDs match the visible box order.
        source_text_items = items if layout_input_active else (
            source.get("items", []) if isinstance(source, dict) else []
        )
        auto_translate = saved_editor_state.get("autoTranslate") is True
        did_translate = False
        translation_settings = saved_editor_state.get("translationSettings")
        if not isinstance(translation_settings, dict):
            translation_settings = {}
        if auto_translate:
            translation_settings = {
                "source_language": translation_settings.get("source_language", "Auto Detect"),
                "target_language": translation_settings.get("target_language", "English"),
                "model_size": translation_settings.get("model_size", "4B"),
                "device": translation_settings.get("device", "default"),
                "prompt_mode": translation_settings.get("prompt_mode", "auto"),
                "max_new_tokens": translation_settings.get("max_new_tokens", 0),
                "max_input_tokens": translation_settings.get("max_input_tokens", 0),
                "quantization": translation_settings.get("quantization", "none"),
                "keep_model_loaded": translation_settings.get("keep_model_loaded", True),
            }
            translation_segments = _translation_segments(summary_caption, meta, source_text_items)
            if translation_segments:
                try:
                    from .translation_api import translate_segments
                    translation_result = translate_segments(translation_segments, translation_settings)
                    translated_document = _apply_translated_values(
                        document, translation_result, summary_caption, meta,
                        source_items=source_text_items,
                        compiled_source_indices=None if layout_input_active else source_item_indices,
                    )
                    if translated_document is None:
                        raise RuntimeError("The translated fields did not match the current MOSS layout.")
                    document = translated_document
                    items = document["items"]
                    summary_object = document["summary"]
                    summary_caption = str(summary_object.get("caption", ""))
                    meta = summary_object.get("meta", []) if isinstance(summary_object.get("meta", []), list) else []
                    saved_editor_state["translationSettings"] = translation_result.get("settings", translation_settings)
                    did_translate = True
                except Exception as exc:
                    raise RuntimeError(f"MOSS Layout YDR automatic translation failed: {exc}") from exc

        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        prompt = compile_moss_prompt(document)
        moss_elements, character_boxes = build_moss_elements(items, width, height)
        result = (prompt, width, height, items, encoded, moss_elements,
                  summary_object["caption"], character_boxes)
        try:
            input_megapixels_active = float(input_megapixels) > 0
        except (TypeError, ValueError):
            input_megapixels_active = False
        target_megapixels = _target_megapixels(resolution, megapixels, input_megapixels)
        ui = {
            "moss_layout_size": [{
                "width": width,
                "height": height,
                "aspect_ratio": "Custom" if resizing_background or wired_size is not None else aspect_ratio,
                "portrait": bool(portrait),
                "megapixels": target_megapixels,
                "input_megapixels_active": input_megapixels_active,
                "layout_input_hash": layout_input_hash,
                "layout_input_suppressed": layout_input_suppressed,
                "source": "background_resize" if resizing_background else (
                    "wired_dimensions" if wired_size is not None else (
                        "input_megapixels" if input_megapixels_active else (
                            "layout_text" if use_layout_canvas else "controls"
                        )
                    )
                ),
            }]
        }
        if layout_input_active:
            editor_items = []
            for item in items:
                editor_item = dict(item)
                x1, y1, x2, y2 = item["bbox"]
                editor_item["bbox"] = [x1 / width, y1 / height, x2 / width, y2 / height]
                editor_items.append(editor_item)
            ui["moss_layout_import"] = [{
                "items": editor_items,
                "summary": {
                    "caption": summary_caption,
                    "meta": meta,
                    "palette": summary_palette,
                    "canvas": summary_canvas if isinstance(summary_canvas, str) and summary_canvas in {"single", "multi_panel", "collage"} else "",
                },
                "has_summary": imported_layout and "summary" in source,
                "has_dimensions": imported_dimensions,
                "input_hash": layout_input_hash,
                "clear_suppression": not did_translate,
                "suppress_input": did_translate,
            }]
        if did_translate:
            if layout_input_active:
                ui["moss_layout_import"][-1]["has_summary"] = True
            else:
                ui["moss_layout_replace"] = [{
                    "summary": summary_object.get("caption", ""),
                    "meta": meta,
                    "items": [
                        {
                            "source_index": source_item_indices[index] if index < len(source_item_indices) else index,
                            **{key: item[key] for key in ("caption", "text", "tags") if key in item},
                        }
                        for index, item in enumerate(items)
                    ],
                    "translation_settings": saved_editor_state.get("translationSettings", translation_settings),
                }]
        image = background_resize if background_resize is not None else background
        if image is not None:
            # Echo an IMAGE preview so the node can paint wired backgrounds without adding an
            # IMAGE output socket. This is the same executed-event channel Deno reads.
            import numpy as np
            from PIL import Image
            import folder_paths
            preview_name = f"moss_layout_bg_{uuid.uuid4().hex}.png"
            preview_path = os.path.join(folder_paths.get_temp_directory(), preview_name)
            pixels = image[-1].detach().cpu().clamp(0, 1).numpy()
            if pixels.ndim != 3 or pixels.shape[-1] not in (1, 3, 4):
                raise ValueError(f"Expected an IMAGE with 1, 3, or 4 channels; received {pixels.shape}")
            if pixels.shape[-1] == 1:
                pixels = pixels[..., 0]
            Image.fromarray((pixels * 255).astype(np.uint8)).save(preview_path)
            ui["images"] = [{"filename": preview_name, "subfolder": "", "type": "temp"}]
        return {
            "ui": ui,
            "result": result,
        }

