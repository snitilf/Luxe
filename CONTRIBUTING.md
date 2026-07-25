# Contributing

Thanks for wanting to contribute.

**Human-authored pull requests targeting `main` must be raised through `no-mistakes`.**
Pushing through it runs a review/test/lint pipeline and opens a deterministic PR.

Quick workflow:

1. Fork the repo and clone the parent repository.
2. Make changes on a branch.
3. Initialize the gate with your fork as the push target: `no-mistakes init --fork-url git@github.com:<you>/Luxe.git`.
4. Commit and run:

```sh
git push no-mistakes
```

See the no-mistakes documentation for full setup and usage.

Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json` - release automation manages them.
