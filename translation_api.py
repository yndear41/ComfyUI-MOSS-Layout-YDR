# SPDX-License-Identifier: GPL-3.0-only
"""Local TranslateGemma API for translating editable MOSS layout text."""

import asyncio
import re


MAX_SEGMENTS = 512
MAX_SEGMENT_CHARS = 12000
MAX_TOTAL_CHARS = 100000
SEGMENT_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def translate_segments(segments, settings, *, progress=None, interrupt_check=None):
    """Translate authored fields one at a time, in their original order."""
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
            clean_segments.append({
                "id": segment_id,
                "text": value,
            })
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

    # Import only on demand so the layout node remains usable without translation
    # dependencies or model weights installed.
    try:
        from .vendor.translategemma.nodes.translate_node import TranslateGemmaNode
    except Exception as exc:
        raise RuntimeError(
            "TranslateGemma is unavailable. Install requirements-translategemma.txt in the ComfyUI Python environment."
        ) from exc

    translator = TranslateGemmaNode()
    values = {}
    total = len(clean_segments)
    for index, segment in enumerate(clean_segments, start=1):
        field_id = segment["id"]
        if interrupt_check is not None:
            interrupt_check()

        def token_update(tokens, limit):
            progress(field_id, index, total, tokens, limit)

        if progress is not None:
            progress(field_id, index, total)
        try:
            translated = translator._translate_one(
                text=segment["text"],
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
                progress_callback=token_update if progress is not None else None,
                interrupt_check=interrupt_check,
            )[0]
        except Exception as exc:
            message = str(exc).strip() or exc.__class__.__name__
            raise RuntimeError(f"TranslateGemma failed for {segment['id']}: {message}") from exc
        translated_value = str(translated or "").strip()
        if not translated_value:
            raise RuntimeError(
                f"TranslateGemma returned an empty value for {segment['id']}. The original layout is unchanged; try again or use a smaller set of fields."
            )
        if translated_value.startswith("[Error:"):
            raise RuntimeError(
                f"TranslateGemma could not translate {segment['id']}: {translated_value.strip('[] ')}"
            )
        values[segment["id"]] = translated_value
        if interrupt_check is not None:
            interrupt_check()
        if progress is not None:
            progress(field_id, index, total, finished=True)

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
                def run(progress=None):
                    return translate_segments(
                        body.get("segments"), body.get("settings", {}), progress=progress
                    )

                from .local_text_progress import STREAM_TYPE, stream_text_action
                if request.headers.get("Accept") == STREAM_TYPE:
                    return await stream_text_action(request, run)
                result = await asyncio.to_thread(run)
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
