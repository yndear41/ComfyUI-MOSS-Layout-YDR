"""Stream text progress back to the request that started it."""

import asyncio
from contextlib import contextmanager
import json
import threading
import time


STREAM_TYPE = "application/x-ndjson"


async def stream_text_action(request, run):
    from aiohttp import web

    response = web.StreamResponse(headers={
        "Content-Type": STREAM_TYPE,
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
    await response.prepare(request)
    loop = asyncio.get_running_loop()
    events = asyncio.Queue()
    connected = True
    last_token_update = 0.0

    def emit(field_id, index, total, tokens=0, token_limit=0, finished=False):
        nonlocal last_token_update
        if not connected:
            return
        now = time.monotonic()
        if token_limit and not finished and now - last_token_update < 0.12:
            return
        last_token_update = now if token_limit else 0.0
        loop.call_soon_threadsafe(events.put_nowait, {
            "type": "progress", "field_id": field_id, "index": index,
            "total": total, "tokens": tokens, "token_limit": token_limit,
            "finished": finished,
        })

    async def execute():
        try:
            result = await asyncio.to_thread(run, emit)
        except Exception as exc:
            await events.put({"type": "error", "error": str(exc) or type(exc).__name__})
        else:
            await events.put({"type": "result", "result": result})

    worker = asyncio.create_task(execute())
    try:
        while True:
            event = await events.get()
            await response.write((json.dumps(event) + "\n").encode("utf-8"))
            if event["type"] != "progress":
                break
        await response.write_eof()
    except ConnectionResetError:
        pass
    finally:
        connected = False
        if not worker.done():
            worker.cancel()
    return response


@contextmanager
def capture_clip_progress(callback, *, preserve_interrupt=False):
    # CLIP exposes token counts through Comfy's global hook. Intercept only
    # updates from this worker and forward other workers' updates as usual.
    from comfy.model_management import InterruptProcessingException
    import comfy.utils as utils

    previous = utils.PROGRESS_BAR_HOOK
    thread_id = threading.get_ident()
    active = True

    def hook(value, total=None, preview=None, *args, **kwargs):
        if active and threading.get_ident() == thread_id:
            callback(value, total)
        elif previous is not None:
            previous(value, total, preview, *args, **kwargs)

    utils.set_progress_bar_global_hook(hook)
    try:
        yield
    except InterruptProcessingException as exc:
        if preserve_interrupt:
            raise
        raise RuntimeError("Text generation was interrupted.") from exc
    finally:
        active = False
        if utils.PROGRESS_BAR_HOOK is hook:
            utils.set_progress_bar_global_hook(previous)
