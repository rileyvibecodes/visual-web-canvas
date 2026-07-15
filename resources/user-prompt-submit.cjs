#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 2;
const DEFAULT_STALE_SECONDS = 300;
const MAX_CONTEXT_CHARS = 9_500;

async function main() {
  const input = await readInput();
  const cwd = path.resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const directory = path.join(os.homedir(), '.visual-web-canvas', 'state');
  const candidates = await readCandidates(directory);
  const now = Date.now();
  const staleSeconds = positiveNumber(process.env.VISUAL_WEB_CANVAS_STALE_SECONDS) ?? DEFAULT_STALE_SECONDS;

  const state = candidates
    .filter((candidate) => isEligible(candidate, cwd, now, staleSeconds))
    .sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt))[0];
  if (!state) return;
  if (!(await documentStillMatches(state))) return;

  const context = formatContext(state, cwd).slice(0, MAX_CONTEXT_CHARS);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }));
}

async function readInput() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  if (!value.trim()) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

async function readCandidates(directory) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(directory, entry.name), 'utf8'));
      results.push(parsed);
    } catch {}
  }
  return results;
}

function isEligible(state, cwd, now, staleSeconds) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || !state.element || !state.viewport) return false;
  if (typeof state.workspaceRoot !== 'string') return false;
  const heartbeat = Date.parse(state.heartbeatAt);
  if (!Number.isFinite(heartbeat) || now - heartbeat > staleSeconds * 1000) return false;
  return overlaps(cwd, path.resolve(state.workspaceRoot)) || (state.documentPath && isWithin(path.resolve(state.documentPath), cwd));
}

async function documentStillMatches(state) {
  if (!state.documentPath || !state.documentHash || state.mode === 'live') return true;
  if (state.documentDirty) return true;
  try {
    const contents = await fs.promises.readFile(state.documentPath);
    const hash = crypto.createHash('sha256').update(contents).digest('hex');
    return hash === state.documentHash;
  } catch {
    return false;
  }
}

function formatContext(state, cwd) {
  const element = state.element;
  const relative = state.documentPath ? path.relative(cwd, state.documentPath) || path.basename(state.documentPath) : '';
  const styles = Object.entries(element.computedStyles ?? {}).map(([key, value]) => `${key}: ${value}`).join('; ');
  const attributes = Object.entries(element.attributes ?? {}).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  const screenshots = [
    state.screenshots?.element ? `Element screenshot: ${state.screenshots.element}` : '',
    state.screenshots?.viewport ? `Viewport screenshot: ${state.screenshots.viewport}` : '',
  ].filter(Boolean).join('\n');

  return [
    '<visual_web_canvas_selection>',
    'The user has an active element selected in Visual Web Canvas. References such as “this”, “that element”, or “this section” refer to this selection.',
    `Canvas mode: ${state.mode}`,
    state.liveUrl ? `Rendered URL: ${state.liveUrl}` : '',
    relative ? `File: ${relative}` : '',
    state.documentPath ? `Absolute file: ${state.documentPath}` : '',
    element.sourceRange ? `Source range: lines ${element.sourceRange.startLine}-${element.sourceRange.endLine}, offsets ${element.sourceRange.startOffset}-${element.sourceRange.endOffset}` : '',
    state.react?.componentName ? `React component: ${state.react.componentName}` : '',
    state.react?.filePath ? `React source: ${state.react.filePath}:${state.react.lineNumber ?? 1}:${state.react.columnNumber ?? 1}` : '',
    state.react?.stack ? `React component stack:\n${truncate(state.react.stack, 2_000)}` : '',
    state.accessibility?.role || state.accessibility?.name ? `Accessibility: role=${state.accessibility?.role || 'unknown'} name=${JSON.stringify(state.accessibility?.name || '')}` : '',
    `Selector: ${element.selector}`,
    `Ancestor trail: ${(element.ancestorTrail ?? []).join(' > ')}`,
    attributes ? `Attributes: ${attributes}` : '',
    `Bounds: ${round(element.bounds.width)}×${round(element.bounds.height)} at (${round(element.bounds.x)}, ${round(element.bounds.y)})`,
    `Viewport: ${state.viewport.width}×${state.viewport.height}, scroll (${round(state.viewport.scrollX)}, ${round(state.viewport.scrollY)})`,
    styles ? `Computed styles: ${styles}` : '',
    '',
    state.comment?.text ? `Visual comment: ${state.comment.text}` : '',
    state.mode === 'static' ? 'Canonical source:' : 'Rendered element:',
    '```html',
    truncate(element.sourceHtml, 4_000),
    '```',
    element.renderedHtml && element.renderedHtml !== element.sourceHtml ? `Rendered DOM:\n\`\`\`html\n${truncate(element.renderedHtml, 2_000)}\n\`\`\`` : '',
    screenshots,
    state.mode === 'static'
      ? 'Edit the canonical HTML file above.'
      : 'Edit the underlying source file when confidently resolved; otherwise use the component stack and selector to locate it. Do not edit generated DOM.',
    '</visual_web_canvas_selection>',
  ].filter((line) => line !== '').join('\n');
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

function overlaps(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function round(value) {
  return Math.round(Number(value) || 0);
}

main().catch(() => process.exitCode = 0);

module.exports = { formatContext, isEligible };
