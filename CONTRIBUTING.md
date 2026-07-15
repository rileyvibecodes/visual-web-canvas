# Contributing

Thanks for helping improve Visual Web Canvas.

## Setup

```sh
npm install
npm run check
```

Press `F5` from VS Code to launch an Extension Development Host. Open `examples/static-landing-page.html` for static mode or run a local React/Vite/Next app before testing live mode.

## Pull requests

- Keep changes focused and explain the user workflow they improve.
- Add tests for source transforms, protocol changes, settings merges, paths, and proxy behavior.
- Never add private funnels, client assets, proprietary copy, tokens, or captured screenshots.
- Preserve safe fallback behavior: ambiguous React/source mapping must not become a source write.
- Update `CHANGELOG.md` for user-visible behavior.
- Run `npm run check` and `npm run package` before requesting review.

Changes derived from another project must be license-compatible and recorded in `THIRD_PARTY_NOTICES.md`.
