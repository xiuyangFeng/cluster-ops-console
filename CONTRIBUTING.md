# Contributing

## Before a PR

1. Do not commit `config.local.json`, real host addresses, passwords, private keys, tokens, `known_hosts`, or runtime logs.
2. Team `config.json` carries only the shared cluster entry point, which `scripts/release-scan.mjs` allowlists explicitly. Any other real address, and every personal machine, belongs in the local personal layer.
3. Run `npm test` and `npm run lint`. Do not download extra packages in CI notes; `npm ci --ignore-scripts` is enough for unit tests.
4. If you change the Web UI, run `npm run test:browser` (or the Electron smoke) and exercise the flow, not just a screenshot.
5. Keep lint fixes limited to errors you introduced. Do not reformat the tree.
6. Bump `package.json`, `CHANGELOG.md`, and `work/monitor/public/assets/js/changelog-data.js` together. The first changelog entry must match the package version.

## Tests

- Unit tests must not open real SSH sessions, kill unrelated processes, or publish releases.
- Password tests assert that secrets never appear in JSON, argv, env, logs, or SSE.

## License and conduct

By contributing you agree the work is licensed under MIT (`LICENSE`) and follows `CODE_OF_CONDUCT.md`.
