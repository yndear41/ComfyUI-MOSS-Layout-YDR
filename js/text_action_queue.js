// SPDX-License-Identifier: GPL-3.0-only
import { api } from "/scripts/api.js";
import { registerQueueProgressJob, showQueueProgressLabel, clearQueueProgressLabel } from "./queue_progress_label.js";

let actionNumber = 0;
let lastSubmission = Promise.resolve();

function nodePath(graph, target, path = [], visited = new Set()) {
  if (!graph || visited.has(graph)) return null;
  visited.add(graph);
  for (const node of graph._nodes ?? graph.nodes ?? []) {
    const childPath = [...path, node.id];
    if (node === target) return childPath.join(":");
    const nested = node.subgraph;
    const match = nodePath(nested?.graph ?? nested, target, childPath, visited);
    if (match) return match;
  }
  return null;
}

function isLink(input) {
  return Array.isArray(input) && input.length === 2
    && typeof input[0] === "string" && Number.isInteger(input[1]);
}

function clipAncestors(output, clip) {
  const prompt = Object.create(null);
  const pending = [clip[0]];
  while (pending.length) {
    const id = pending.pop();
    if (Object.hasOwn(prompt, id)) continue;
    const entry = output[id];
    if (!entry) throw new Error("ComfyUI could not resolve the connected CLIP branch.");
    prompt[id] = entry;
    for (const input of Object.values(entry.inputs ?? {})) {
      if (isLink(input)) pending.push(input[0]);
    }
  }
  return prompt;
}

async function queueJson(path, options) {
  const response = await api.fetchApi(path, options);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    const nodeErrors = Object.values(body?.node_errors ?? {});
    const reason = nodeErrors.flatMap((node) => node.errors ?? [])[0];
    const error = body?.error;
    throw new Error(reason?.details || reason?.message || error?.message || error
      || `ComfyUI queue request failed (${response.status}).`);
  }
  return body;
}

function resultFromHistory(entry, runnerId) {
  const messages = entry.status?.messages ?? [];
  if (messages.some(([type]) => type === "execution_interrupted")) {
    throw new Error("Text action interrupted.");
  }
  const failure = messages.find(([type]) => type === "execution_error");
  if (failure) throw new Error(failure[1]?.exception_message || "ComfyUI could not run the text action.");
  const result = actionResult(entry.outputs?.[runnerId]);
  if (!result) {
    throw new Error("ComfyUI finished without returning the action result.");
  }
  return result;
}

function actionResult(output) {
  const result = output?.moss_text_action?.[0];
  return result?.values && typeof result.values === "object" ? result : null;
}

async function pollTextResult(promptId, runnerId, signal) {
  const historyPath = `/history/${encodeURIComponent(promptId)}`;
  const options = { cache: "no-store", signal };
  let missing = 0, readErrors = 0;
  while (!signal.aborted) {
    let entry, queue;
    try {
      const history = await queueJson(historyPath, options);
      entry = history[promptId];
      if (!entry) queue = await queueJson("/queue", options);
      readErrors = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (++readErrors >= 5) {
        throw new Error(`Could not read the result of ComfyUI job ${promptId}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (entry) return resultFromHistory(entry, runnerId);

    const present = [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])]
      .some((entry) => entry[1] === promptId);
    missing = present ? 0 : missing + 1;
    // Each pass reads history first. A job can finish between the history
    // and queue reads, so wait for another successful pass before reporting removal.
    if (missing >= 2) throw new Error("The text action was removed from the ComfyUI queue.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export function queueTextAction(app, node, kind, payload, callbacks) {
  const previous = lastSubmission;
  let release;
  const submitted = new Promise((resolve) => { release = resolve; });
  lastSubmission = previous.then(() => submitted);
  const submit = async (options) => {
    await previous;
    try { return await queueJson("/prompt", options); }
    finally { release(); }
  };
  return executeTextAction(app, node, kind, payload, callbacks, submit).finally(release);
}

async function executeTextAction(app, node, kind, payload, { onQueued, onProgress }, submit) {
  let prompt = Object.create(null), clip, workflow;
  if (kind !== "translate") {
    const root = app.rootGraph ?? app.graph;
    const id = nodePath(root, node);
    const bundle = await app.graphToPrompt();
    const output = bundle?.output ?? {};
    clip = id == null ? null : output[id]?.inputs?.clip;
    if (!isLink(clip)) throw new Error("Connect a CLIP encoder to MOSS Layout YDR and enable its branch.");
    prompt = clipAncestors(output, clip);
    workflow = bundle.workflow;
  }
  const runnerId = `moss-text-${Date.now()}-${++actionNumber}`;
  const title = { generate: "Generate", edit: "Edit", translate: "Translate", geometry: "Box Geometry" }[kind];
  prompt[runnerId] = {
    class_type: "MOSSLayoutTextAction",
    inputs: { payload: JSON.stringify({ ...payload, kind }), ...(clip && { clip }) },
    _meta: { title: `MOSS Layout YDR · ${title}` },
  };

  const stopPolling = new AbortController();
  let promptId, firstProgress, earlyResult, resolveResult;
  let receivedProgress = false;
  const liveResult = new Promise((resolve) => { resolveResult = resolve; });
  const showProgress = (data) => {
    const label = onProgress(data);
    const percent = data.max > 0 ? Math.round(100 * data.value / data.max) : undefined;
    if (label) showQueueProgressLabel(promptId, label, percent, runnerId);
  };
  const receiveProgress = (event) => {
    const data = event.detail;
    if (data?.node !== runnerId || (promptId && data.prompt_id !== promptId)) return;
    receivedProgress = true;
    if (!promptId) firstProgress = data;
    else showProgress(data);
  };
  const receiveStart = (event) => {
    const data = event.detail;
    if (receivedProgress || data?.nodes?.[runnerId]?.state !== "running") return;
    const total = payload.segments?.length ?? 1;
    receiveProgress({ detail: {
      node: runnerId, prompt_id: data.prompt_id, index: 1, total,
      tokens: 0, token_limit: 0, value: 0, max: total,
    } });
  };
  const receiveResult = (event) => {
    const data = event.detail;
    if (data?.node !== runnerId) return;
    const result = actionResult(data.output);
    if (!result) return;
    if (!promptId) earlyResult = { promptId: data.prompt_id, result };
    else if (data.prompt_id === promptId) resolveResult(result);
  };
  api.addEventListener("moss_layout_text_progress", receiveProgress);
  api.addEventListener("progress_state", receiveStart);
  api.addEventListener("executed", receiveResult);
  try {
    const submitted = await submit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: api.clientId ?? "",
        prompt,
        partial_execution_targets: [runnerId],
        ...(workflow && { extra_data: { extra_pnginfo: { workflow } } }),
      }),
      skipStatusRetry: true,
    });
    promptId = submitted.prompt_id;
    if (!promptId) throw new Error("ComfyUI did not return a job ID for the text action.");
    registerQueueProgressJob(promptId, prompt);
    onQueued();
    if (firstProgress?.prompt_id === promptId) showProgress(firstProgress);
    if (earlyResult?.promptId === promptId) return earlyResult.result;
    return await Promise.race([liveResult, pollTextResult(promptId, runnerId, stopPolling.signal)]);
  } finally {
    stopPolling.abort();
    clearQueueProgressLabel(promptId);
    api.removeEventListener("moss_layout_text_progress", receiveProgress);
    api.removeEventListener("progress_state", receiveStart);
    api.removeEventListener("executed", receiveResult);
  }
}
