# Contributing

Thanks for wanting to contribute.

Pull requests target `main`. Before opening one, run the full gate locally:

```sh
npm ci
npm run check
```

`npm run check` builds the bundle, verifies the generated skill files are in sync, runs the design
adherence and naming gates, then lint, formatting, types, and the test suite. CI runs the same
thing on Linux, macOS, and Windows, so a green local run is a good predictor of a green PR.

Keep commits small and single-purpose, and write them as `type(scope): summary`. The version
number and changelog are derived from those messages, so the type matters: `feat` and `fix` appear
in the changelog and drive the release, and anything else does not.

Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json` - release automation manages them.
