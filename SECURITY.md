# Security policy

## Supported versions

Security fixes are released for the latest Marketplace/GitHub release.

## Reporting

Do not open a public issue for a vulnerability that could expose workspace files, execute untrusted code, escape the preview root, or leak captured context. Use GitHub's private vulnerability reporting for `rileyvibecodes/visual-web-canvas`.

Include the extension version, VS Code/Cursor version, local or Remote SSH mode, operating system, and a minimal reproduction without private page content.

## Trust model

- Static HTML is parsed as untrusted content. Authored scripts are disabled, forms/frames are blocked, and local assets must resolve inside the workspace.
- Live mode deliberately executes the user's running development application. It accepts loopback HTTP(S) targets only and must not be used for untrusted remote sites.
- React source editing runs only in development and rejects paths outside the open workspace.
- Claude context and screenshots remain local. They are supplied to Claude Code only when the user submits a prompt through their installed Claude Code client.
- Cursor integration is a local stdio MCP server. It reads only the latest private canvas state and an explicitly captured screenshot.
- The installer backs up Claude/Cursor JSON settings and merges only its own entry.

## Out of scope

Security bugs in a previewed application, Claude Code, Cursor, VS Code, React Grab, or React Rewrite should also be reported to the relevant upstream project.
