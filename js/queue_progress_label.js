// SPDX-License-Identifier: GPL-3.0-only
const labelClass = "moss-ydr-queue-field-label";
const hiddenClass = "moss-ydr-queue-original-label";
const labels = new Map();
let activeLabel, observer, frame, styles;
let rgthreeService;

function withRgthree(callback) {
  if (!document.querySelector("rgthree-progress-bar")) return;
  rgthreeService ??= import("../../rgthree/common/prompt_service.js").then(
    (module) => module.SERVICE,
    () => null,
  );
  rgthreeService.then((service) => {
    if (service) callback(service);
  });
}

export function registerQueueProgressJob(promptId, output) {
  withRgthree((service) => {
    const execution = service.getOrMakePrompt?.(promptId);
    if (!execution || execution.promptApi) return;
    // rgthree normally gets this from its api.queuePrompt wrapper. Keep only
    // progress metadata, since the queue payload may contain a reference image.
    const nodes = Object.fromEntries(Object.entries(output).map(([id, node]) => [
      id, { class_type: node.class_type, _meta: node._meta, inputs: {} },
    ]));
    execution.setPrompt({ output: nodes });
    if (service.currentExecution === execution) service.dispatchProgressUpdate();
  });
}

function updateRgthreeLabel(label) {
  withRgthree((service) => {
    if (activeLabel !== label) return;
    const execution = service.currentExecution;
    const current = execution?.currentlyExecuting;
    if (execution?.id !== label.promptId || execution.errorDetails
      || !current || current.nodeId !== label.runnerId || current.nodeLabel === label.text) return;
    current.nodeLabel = label.text;
    service.dispatchProgressUpdate();
  });
}

function progressTargets(promptId) {
  const targets = new Map();
  // The full queue overlay and compact toolbar have separate labels.
  for (const fill of document.querySelectorAll('[data-testid="queue-progress-node-fill"]')) {
    const label = fill.parentElement?.nextElementSibling?.querySelector("span.truncate");
    if (label) targets.set(label, "replace");
  }
  const compact = '[role="status"][aria-live="polite"][aria-atomic="true"] > div:last-child > span[title]';
  for (const label of document.querySelectorAll(compact)) {
    if (!label.classList.contains(labelClass) && label.nextElementSibling?.classList.contains("tabular-nums")) {
      targets.set(label, "replace");
    }
  }
  if (!targets.size) {
    // Some toolbar layouts render only the colored line.
    for (const bar of document.querySelectorAll('[data-testid="queue-inline-progress"]')) {
      if (bar.parentElement) targets.set(bar.parentElement, "toolbar");
    }
  }
  for (const row of document.querySelectorAll(`[data-job-id="${CSS.escape(promptId)}"]`)) {
    const textColumn = row.querySelector("div.flex-col.text-xs");
    if (textColumn) targets.set(textColumn, "history");
  }
  return targets;
}

function removeLabel(target, label) {
  target.classList.remove(hiddenClass);
  label.remove();
  labels.delete(target);
}

function renderLabels() {
  frame = undefined;
  if (!activeLabel) return;
  const targets = progressTargets(activeLabel.promptId);
  for (const [target, label] of labels) {
    if (!targets.has(target) || !label.isConnected) removeLabel(target, label);
  }
  for (const [target, mode] of targets) {
    let label = labels.get(target);
    if (!label) {
      label = document.createElement("span");
      label.className = `${labelClass} ${labelClass}--${mode}`;
      if (mode === "replace") {
        target.before(label);
        target.classList.add(hiddenClass);
      } else {
        target.append(label);
      }
      labels.set(target, label);
    }
    const { text, percent } = activeLabel;
    const content = mode !== "replace" && Number.isFinite(percent) ? `${text} · ${percent}%` : text;
    if (label.textContent !== content) {
      label.textContent = content;
      label.title = content;
    }
  }
}

function scheduleLabels() {
  if (frame === undefined) frame = requestAnimationFrame(renderLabels);
}

export function showQueueProgressLabel(promptId, text, percent, runnerId) {
  if (!promptId || !text) return;
  if (activeLabel?.promptId === promptId && activeLabel.text === text && activeLabel.percent === percent) {
    updateRgthreeLabel(activeLabel);
    return;
  }
  activeLabel = { promptId, text, percent, runnerId };
  updateRgthreeLabel(activeLabel);
  if (!styles) {
    styles = document.createElement("style");
    styles.textContent = `
      .${hiddenClass}{display:none!important}
      .${labelClass}{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .${labelClass}--replace{display:inline-block;max-width:32ch;margin-inline:4px}
      .${labelClass}--history{display:block;color:var(--muted-foreground,inherit)}
      :has(> .${labelClass}--history) > .text-muted-foreground{display:none}
      .${labelClass}--toolbar{position:absolute;inset-block-start:100%;inset-inline-end:0;max-width:min(38ch,80vw);margin-top:4px;padding:3px 7px;border-radius:4px;background:var(--background,#171a1d);color:var(--foreground,#d3d8da);font-size:12px}
    `;
    document.head.append(styles);
  }
  if (!observer) {
    observer = new MutationObserver(scheduleLabels);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  scheduleLabels();
}

export function clearQueueProgressLabel(promptId) {
  if (!activeLabel || activeLabel.promptId !== promptId) return;
  activeLabel = undefined;
  observer?.disconnect();
  observer = undefined;
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  for (const [target, label] of labels) removeLabel(target, label);
}
