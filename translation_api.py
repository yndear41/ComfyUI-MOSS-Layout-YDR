# SPDX-License-Identifier: GPL-3.0-only
"""Local TranslateGemma API for translating editable MOSS layout text."""

import asyncio
import hashlib
import json
import re
import uuid


MAX_SEGMENTS = 512
MAX_SEGMENT_CHARS = 12000
MAX_TOTAL_CHARS = 100000
SEGMENT_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _fingerprint(segments, settings):
    relevant_settings = {
        key: settings.get(key)
        for key in (
            "source_language", "target_language", "model_size", "device", "prompt_mode",
            "max_new_tokens", "max_input_tokens", "quantization",
        )
    }
    return hashlib.sha256(_canonical({"segments": segments, "settings": relevant_settings}).encode("utf-8")).hexdigest()


def source_key(segments, settings):
    """Compact cross-language key used to reject stale saved translations."""
    relevant_settings = {
        key: settings.get(key)
        for key in (
            "device", "max_input_tokens", "max_new_tokens", "model_size", "prompt_mode",
            "quantization", "source_language", "target_language",
        )
    }
    payload = _canonical({"segments": segments, "settings": relevant_settings})
    value = 0xCBF29CE484222325
    prime = 0x100000001B3
    for character in payload:
        codepoint = ord(character)
        units = (codepoint,) if codepoint <= 0xFFFF else (
            0xD800 + ((codepoint - 0x10000) >> 10),
            0xDC00 + ((codepoint - 0x10000) & 0x3FF),
        )
        for unit in units:
            for byte in (unit & 0xFF, unit >> 8):
                value = ((value ^ byte) * prime) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def translate_segments(segments, settings):
    """Translate all authored text in one model call and map it back by stable IDs."""
    if not isinstance(segments, list) or not segments or len(segments) > MAX_SEGMENTS:
        raise ValueError(f"Translation requires 1–{MAX_SEGMENTS} text segments.")
    if not isinstance(settings, dict):
        raise ValueError("Translation settings must be an object.")

    clean_segments = []
    seen = set()
    total = 0
    for entry in segments:
        if not isinstance(entry, dict):
            raise ValueError("Each translation segment must contain an id and text.")
        segment_id, value = entry.get("id"), entry.get("text")
        if not isinstance(segment_id, str) or not SEGMENT_ID.fullmatch(segment_id) or segment_id in seen:
            raise ValueError("Translation segment IDs must be unique and use letters, numbers, . _ : or -.")
        if not isinstance(value, str):
            raise ValueError(f"Text segment {segment_id} is not a string.")
        if len(value) > MAX_SEGMENT_CHARS:
            raise ValueError(f"Text segment {segment_id} is longer than {MAX_SEGMENT_CHARS} characters.")
        seen.add(segment_id)
        total += len(value)
        if value.strip():
            clean_segments.append({"id": segment_id, "text": value})
    if total > MAX_TOTAL_CHARS:
        raise ValueError(f"The layout text is longer than {MAX_TOTAL_CHARS} characters.")
    if not clean_segments:
        raise ValueError("There is no text to translate.")

    allowed_models = {"4B", "12B", "27B"}
    model_size = str(settings.get("model_size", "4B"))
    if model_size not in allowed_models:
        raise ValueError("Choose a TranslateGemma model size: 4B, 12B or 27B.")
    target_language = str(settings.get("target_language", "English"))
    source_language = str(settings.get("source_language", "Auto Detect"))
    device = str(settings.get("device", "default"))
    prompt_mode = str(settings.get("prompt_mode", "auto"))
    quantization = str(settings.get("quantization", "none"))
    if prompt_mode not in {"auto", "structured", "plain"}:
        prompt_mode = "auto"
    if quantization not in {"none", "bnb-8bit", "bnb-4bit"}:
        quantization = "none"
    from .vendor.translategemma.utils.language_utils import get_language_names
    languages = set(get_language_names())
    if target_language not in languages or (source_language != "Auto Detect" and source_language not in languages):
        raise ValueError("Choose a source and target language from the supported language list.")
    if device != "default" and device != "cpu" and not re.fullmatch(r"gpu:\d+", device):
        device = "default"
    try:
        max_new_tokens = max(0, min(8192, int(settings.get("max_new_tokens", 0))))
        max_input_tokens = max(0, min(8192, int(settings.get("max_input_tokens", 0))))
    except (TypeError, ValueError):
        max_new_tokens, max_input_tokens = 0, 0

    nonce = uuid.uuid4().hex[:16]
    markers = {}
    blocks = []
    for index, segment in enumerate(clean_segments):
        start = f"[[YDR_{nonce}_{index:04d}_BEGIN]]"
        end = f"[[YDR_{nonce}_{index:04d}_END]]"
        markers[segment["id"]] = (start, end)
        blocks.append(f"{start}\n{segment['text']}\n{end}")
    payload = "\n\n".join(blocks)

    # Import only on demand so the layout node remains usable without translation
    # dependencies or model weights installed.
    try:
        from .vendor.translategemma.nodes.translate_node import TranslateGemmaNode
    except Exception as exc:
        raise RuntimeError(
            "TranslateGemma is unavailable. Install requirements-translategemma.txt in the ComfyUI Python environment."
        ) from exc

    try:
        translated = TranslateGemmaNode()._translate_one(
            text=payload,
            target_language=target_language,
            model_size=model_size,
            device=device,
            source_language=source_language,
            prompt_mode=prompt_mode,
            max_new_tokens=max_new_tokens,
            max_input_tokens=max_input_tokens,
            truncate_input=False,
            strict_context_limit=True,
            keep_model_loaded=bool(settings.get("keep_model_loaded", True)),
            debug=False,
            chinese_conversion_only=False,
            long_text_strategy="disable",
            quantization=quantization,
        )[0]
    except Exception as exc:
        message = str(exc).strip() or exc.__class__.__name__
        raise RuntimeError(f"TranslateGemma failed: {message}") from exc

    values = {}
    for segment_id, (start, end) in markers.items():
        pattern = re.compile(re.escape(start) + r"\s*(.*?)\s*" + re.escape(end), re.DOTALL)
        matches = pattern.findall(translated)
        if len(matches) != 1:
            raise RuntimeError(
                "TranslateGemma changed or omitted a layout marker. The original layout is unchanged; try a smaller model or fewer text fields."
            )
        translated_value = matches[0]
        if not translated_value.strip():
            raise RuntimeError(
                "TranslateGemma returned an empty value for one of the layout fields. The original layout is unchanged; try again or use a smaller set of fields."
            )
        values[segment_id] = translated_value

    normalized_settings = {
        "source_language": source_language,
        "target_language": target_language,
        "model_size": model_size,
        "device": device,
        "prompt_mode": prompt_mode,
        "max_new_tokens": max_new_tokens,
        "max_input_tokens": max_input_tokens,
        "quantization": quantization,
        "keep_model_loaded": bool(settings.get("keep_model_loaded", True)),
    }
    return {
        "status": "ready",
        "signature": _fingerprint(clean_segments, normalized_settings),
        "source_key": source_key(clean_segments, normalized_settings),
        "values": values,
        "settings": normalized_settings,
    }


def register_routes():
    """Register small local endpoints used by the embedded layout editor dialog."""
    try:
        from aiohttp import web
        from server import PromptServer
        from .vendor.translategemma.utils.language_utils import get_language_names
    except Exception:
        return False

    routes = PromptServer.instance.routes
    try:
        @routes.get("/moss_layout_ydr/translation/languages")
        async def moss_layout_translation_languages(_request):
            devices = ["default", "cpu"]
            try:
                from .vendor.translategemma.utils.model_loader import get_device_options
                devices = list(get_device_options())
            except Exception:
                pass
            if "default" not in devices:
                devices.insert(0, "default")
            if "cpu" not in devices:
                devices.insert(1, "cpu")
            return web.json_response({"languages": get_language_names(), "devices": devices})

        @routes.post("/moss_layout_ydr/translation/run")
        async def moss_layout_translation_run(request):
            if request.content_length and request.content_length > 1_000_000:
                raise web.HTTPRequestEntityTooLarge(max_size=1_000_000, actual_size=request.content_length)
            try:
                body = await request.json()
                result = await asyncio.to_thread(
                    translate_segments, body.get("segments"), body.get("settings", {})
                )
                return web.json_response(result)
            except ValueError as exc:
                return web.json_response({"status": "error", "error": str(exc)}, status=400)
            except Exception as exc:
                return web.json_response({"status": "error", "error": str(exc)}, status=500)
    except Exception as exc:
        # ComfyUI may re-import a custom node during development; duplicate routes
        # should not prevent all other nodes from loading.
        if "registered" not in str(exc).lower() and "duplicate" not in str(exc).lower():
            print(f"[MOSS Layout YDR] Could not register translation routes: {exc}")
        return False
    return True
