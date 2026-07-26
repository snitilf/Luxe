# Development

## From source

```sh
git clone https://github.com/snitilf/Luxe.git
cd Luxe
npm ci
npm run build
npm link
```

## Commands

```sh
npm run check          # Run all verification commands
npm run build          # Bundle the publishable CLI, chrome, and design assets
npm run build:skill    # Regenerate the installable luxe skill
npm test               # Run node:test tests
npm run lint           # Run ESLint
npm run format:check   # Check Prettier formatting
npm run typecheck      # Run TypeScript checkJs validation
npm run naming         # Check that no upstream identifiers leaked in
```

`npm run check` is the gate.
Run it green before every commit.

## Contributing

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for branch and commit conventions.
