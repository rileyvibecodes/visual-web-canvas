# Architecture

Visual Web Canvas has two rendering paths and one shared context bridge.

## Static HTML

The extension registers an optional custom editor for `.html` files. `PreviewServer` parses the active `TextDocument` with `parse5`, records exact source ranges, injects temporary element/text IDs into the rendered copy, and disables authored scripts. The browser runtime reports selections and edits back to the extension. Source mutations use `WorkspaceEdit`, so unsaved buffers and VS Code undo remain authoritative.

## Live applications

`Connect Dev Server` validates a loopback URL. For supported React workspaces it launches `react-rewrite-cli` in the workspace, then places `LivePreviewServer` in front of its proxy. The outer server injects the React Grab context runtime and rewrites React Rewrite's source-editing WebSocket through the same externally forwarded VS Code URI. This avoids the common Remote SSH failure where browser-side `localhost` points to the laptop instead of the remote extension host.

Inspect mode captures the DOM, accessibility data, computed styles, React Fiber/component stack, and source location. Design mode yields normal page interaction to React Rewrite's staged editing overlay. If React Rewrite cannot start, the extension connects directly to the dev server in inspect-only mode.

## Claude bridge

Each canvas owns a private state file under `~/.visual-web-canvas/state/`. A visual comment adds its text and requests a cropped screenshot. The installed Claude `UserPromptSubmit` hook selects the freshest state for the current workspace, rejects stale or mismatched static documents, formats a bounded context block, and returns it as `additionalContext`.

The hook never creates or replaces a conversation. The extension uses Claude Code's public `claude-vscode.focus` command only to focus the existing input.

## Cursor beta

The CLI can register a local stdio MCP server in `~/.cursor/mcp.json`. Cursor agents retrieve the latest selection through explicit tools because Cursor does not currently expose a supported per-prompt dynamic-context API equivalent to Claude's hook.

## Protocol evolution

`CanvasSelectionState.schemaVersion` is currently `2`. Breaking state changes require a version increment, hook compatibility update, fixtures for static and live modes, and a cleanup/migration policy.
