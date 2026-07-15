# Third-party notices

Visual Web Canvas is MIT-licensed and builds on excellent open-source work.

## Distributed dependencies

### React Grab

Source: https://github.com/aidenybai/react-grab

License: MIT

Copyright (c) 2025 Aiden Bai

React Grab provides the maintained React Fiber, source-location, component-stack, and structured element-context primitives used by the live runtime.

### React Rewrite

Source: https://github.com/donghaxkim/react-rewrite

License: MIT

Copyright (c) 2025-present Dongha Kim

The live React canvas launches the published `react-rewrite-cli` package for its development-only proxy, visual editing overlay, Tailwind transforms, staged changes, and source-write safety checks. Visual Web Canvas adds an outer VS Code/Remote SSH proxy and Claude context bridge; it does not relicense React Rewrite.

## Design and architecture acknowledgements

- [Design Mode](https://github.com/SandeepBaskaran/design-mode), MIT, Copyright (c) 2026 Sandeep Baskaran — layers, measurement, change-review, comments, and local MCP interaction patterns.
- [ClickContext](https://github.com/gautham-psnl/clickcontext), MIT — compact accessibility/source context and MCP naming patterns.
- [vite-plugin-react-click-to-component](https://github.com/ArnaudBarre/vite-plugin-react-click-to-component), MIT — dev-server injection and editor navigation patterns.

These acknowledgements do not imply endorsement by the upstream maintainers.

Transitive dependency licenses are included in their respective npm packages and can be audited from `package-lock.json`.
