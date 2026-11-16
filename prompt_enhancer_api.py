# SPDX-License-Identifier: GPL-3.0-only
"""Local prompt enhancement using ComfyUI's native CLIP text-generation stack."""

import asyncio
import re
import threading


MAX_SEGMENTS = 512
MAX_SEGMENT_CHARS = 12000
MAX_TOTAL_CHARS = 100000
SEGMENT_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_CLIP_LOCK = threading.RLock()
_CLIP_REGISTRY = {}

DEFAULT_SYSTEM_PROMPT = """You are an expert prompt editor for MOSS-Image.
Improve only the supplied field for clear, specific visual image generation.
Preserve every stated fact, subject, identity, action, relationship, placement,
style, constraint, and intended meaning. When useful, clarify composition,
lighting, camera framing, materials, color, and texture without inventing
subjects, actions, or story details.
Write descriptive prompt text in English unless the field contains exact visible
text; keep that literal text in its original language. Keep wording concise and
natural. Return only the revised field text, with no
preface, quotation marks, explanation, Markdown, or field labels. For metadata
and tags, return a compact comma-separated list. For exact visible text, retain
the exact message and language; only make a correction when the source clearly
contains an obvious typo."""


def cache_connected_clip(node_id, clip):
    """Keep the wired CLIP available to the editor's out-of-queue Generate buttons."""
    node_id = str(node_id or "")
    if not node_id:
        return
    with _CLIP_LOCK:
        if clip is None:
            _CLIP_REGISTRY.pop(node_id, None)
            return
        # The Generate buttons run after the workflow queue has completed. Keep a
        # strong reference so the graph executor cannot collect the CLIP output
        # before a user presses one of those buttons. Re-running with the input
        # disconnected clears the entry; restarting ComfyUI clears all entries.
        _CLIP_REGISTRY[node_id] = clip


def _connected_clip(node_id):
    with _CLIP_LOCK:
        return _CLIP_REGISTRY.get(str(node_id or ""))


def _clip_name(clip):
    tokenizer = getattr(clip, "tokenizer", None)
    return str(getattr(tokenizer, "clip_name", "") or getattr(clip, "name", "") or "Connected CLIP encoder")


def options(node_id=""):
    clip = _connected_clip(node_id)
    return {
        "clip_available": clip is not None,
        "clip_name": _clip_name(clip) if clip is not None else "",
        "default_system_prompt": DEFAULT_SYSTEM_PROMPT,
    }


def _normalize_settings(settings):
    if not isinstance(settings, dict):
        settings = {}
    try:
        max_length = max(16, min(32768, int(settings.get("max_length", 1024))))
        top_k = max(0, min(1000, int(settings.get("top_k", 20))))
        seed = max(0, min(0xFFFFFFFFFFFFFFFF, int(settings.get("seed", 0))))
        temperature = max(0.01, min(2.0, float(settings.get("temperature", 0.7))))
        top_p = max(0.0, min(1.0, float(settings.get("top_p", 0.8))))
        min_p = max(0.0, min(1.0, float(settings.get("min_p", 0.0))))
        repetition_penalty = max(0.0, min(5.0, float(settings.get("repetition_penalty", 1.0))))
        presence_penalty = max(0.0, min(5.0, float(settings.get("presence_penalty", 0.0))))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Generation settings contain an invalid number.") from exc
    system_prompt = str(settings.get("system_prompt") or DEFAULT_SYSTEM_PROMPT).strip()
    if len(system_prompt) > 12000:
        raise ValueError("The system prompt is longer than 12,000 characters.")
    mtp = str(settings.get("mtp", "auto"))
    if mtp not in {"auto", "off", "2", "3", "4", "5", "tree2s1", "tree2s2", "tree3s1", "tree4s1m8"}:
        mtp = "auto"
    sampling_mode = str(settings.get("sampling_mode", "on"))
    if sampling_mode not in {"on", "off"}:
        sampling_mode = "on"
    return {
        "max_length": max_length,
        "thinking": bool(settings.get("thinking", False)),
        "use_default_template": bool(settings.get("use_default_template", True)),
        "temperature": temperature,
        "top_k": top_k,
        "top_p": top_p,
        "min_p": min_p,
        "repetition_penalty": repetition_penalty,
        "presence_penalty": presence_penalty,
        "seed": seed,
        "sampling_mode": sampling_mode,
        "mtp": mtp,
        "system_prompt": system_prompt,
    }


def _generate_field(clip, segment, settings):
    field_type = str(segment.get("type", "prompt field"))[:80]
    source = segment["text"]
    task_prompt = (
        f"Improve this MOSS-Image {field_type}. Preserve the source meaning and all details. "
        "Return only the replacement value.\n\nSOURCE FIELD:\n" + source
    )
    sampling_mode = {
        "sampling_mode": settings["sampling_mode"],
        "temperature": settings["temperature"],
        "top_k": settings["top_k"],
        "top_p": settings["top_p"],
        "min_p": settings["min_p"],
        "repetition_penalty": settings["repetition_penalty"],
        "presence_penalty": settings["presence_penalty"],
        "seed": settings["seed"],
    }
    try:
        from comfy_extras.nodes_textgen import TextGenerateV2
    except ImportError:
        TextGenerateV2 = None

    if TextGenerateV2 is not None:
        result = TextGenerateV2.execute(
            clip=clip,
            prompt=task_prompt,
            max_length=settings["max_length"],
            sampling_mode=sampling_mode,
            thinking=settings["thinking"],
            use_default_template=settings["use_default_template"],
            mtp=settings["mtp"],
            system_prompt=settings["system_prompt"],
        )
        generated = result.args[0] if hasattr(result, "args") else result[0]
    else:
        # Compatibility fallback for ComfyUI versions that predate TextGenerateV2.
        try:
            tokens = clip.tokenize(
                task_prompt,
                skip_template=not settings["use_default_template"],
                min_length=1,
                thinking=settings["thinking"],
                system_prompt=settings["system_prompt"] if settings["use_default_template"] else "",
            )
            generated_ids = clip.generate(
                tokens,
                do_sample=settings["sampling_mode"] == "on",
                max_length=settings["max_length"],
                temperature=settings["temperature"],
                top_k=settings["top_k"],
                top_p=settings["top_p"],
                min_p=settings["min_p"],
                repetition_penalty=settings["repetition_penalty"],
                presence_penalty=settings["presence_penalty"],
                seed=settings["seed"],
            )
            generated = clip.decode(generated_ids)
            if "</think>" in generated:
                generated = generated.split("</think>", 1)[1]
        except Exception as exc:
            raise RuntimeError(f"ComfyUI's text generation failed: {exc}") from exc
    generated = str(generated or "").strip()
    if not generated:
        raise RuntimeError("The model returned an empty result. The original field was kept.")
    return generated


def enhance_segments(node_id, segments, settings):
    if not isinstance(segments, list) or not segments or len(segments) > MAX_SEGMENTS:
        raise ValueError(f"Enhancement requires 1–{MAX_SEGMENTS} text fields.")
    cleaned, seen, total = [], set(), 0
    for entry in segments:
        if not isinstance(entry, dict):
            raise ValueError("Each field must include an id, type, and text.")
        segment_id, text = entry.get("id"), entry.get("text")
        if not isinstance(segment_id, str) or not SEGMENT_ID.fullmatch(segment_id) or segment_id in seen:
            raise ValueError("Field IDs must be unique and use letters, numbers, . _ : or -.")
        if not isinstance(text, str):
            raise ValueError(f"Text field {segment_id} is not a string.")
        if len(text) > MAX_SEGMENT_CHARS:
            raise ValueError(f"Text field {segment_id} is longer than {MAX_SEGMENT_CHARS} characters.")
        seen.add(segment_id)
        total += len(text)
        if text.strip():
            cleaned.append({"id": segment_id, "type": entry.get("type", "prompt field"), "text": text})
    if total > MAX_TOTAL_CHARS:
        raise ValueError(f"The selected text fields exceed {MAX_TOTAL_CHARS} characters.")
    if not cleaned:
        raise ValueError("There are no filled text fields to enhance.")

    normalized = _normalize_settings(settings)
    values = {}
    with _CLIP_LOCK:
        clip = _connected_clip(node_id)
        if clip is None:
            raise RuntimeError("Connect a CLIP encoder to this node and run the workflow once before generating text.")
        for segment in cleaned:
            values[segment["id"]] = _generate_field(clip, segment, normalized)
    return {"status": "ready", "values": values, "settings": normalized}


def register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False
    routes = PromptServer.instance.routes
    try:
        @routes.get("/moss_layout_ydr/prompt-enhancer/options")
        async def moss_layout_enhancer_options(_request):
            try:
                return web.json_response(options(_request.query.get("node_id", "")))
            except Exception as exc:
                return web.json_response({"error": str(exc)}, status=500)

        @routes.post("/moss_layout_ydr/prompt-enhancer/release")
        async def moss_layout_enhancer_release(request):
            try:
                body = await request.json()
                cache_connected_clip(body.get("node_id"), None)
                return web.json_response({"status": "released"})
            except Exception as exc:
                return web.json_response({"error": str(exc)}, status=400)

        @routes.post("/moss_layout_ydr/prompt-enhancer/run")
        async def moss_layout_enhancer_run(request):
            if request.content_length and request.content_length > 1_000_000:
                raise web.HTTPRequestEntityTooLarge(max_size=1_000_000, actual_size=request.content_length)
            try:
                prompt_queue = getattr(PromptServer.instance, "prompt_queue", None)
                if prompt_queue is not None:
                    running, pending = prompt_queue.get_current_queue()
                    if running or pending:
                        return web.json_response({
                            "status": "error",
                            "error": "Wait until the ComfyUI workflow queue is idle before generating prompt text.",
                        }, status=409)
                body = await request.json()
                result = await asyncio.to_thread(
                    enhance_segments, body.get("node_id"), body.get("segments"), body.get("settings", {})
                )
                return web.json_response(result)
            except ValueError as exc:
                return web.json_response({"status": "error", "error": str(exc)}, status=400)
            except Exception as exc:
                return web.json_response({"status": "error", "error": str(exc)}, status=500)
    except Exception as exc:
        if "registered" not in str(exc).lower() and "duplicate" not in str(exc).lower():
            print(f"[MOSS Layout YDR] Could not register prompt enhancer routes: {exc}")
        return False
    return True
