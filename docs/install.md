# Install

## The skill (recommended)

Install the Luxe skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add snitilf/Luxe --skill luxe
```

That is the entire setup, with no npm install needed.
The skill teaches your agent to run Luxe through `npx -y editeur-luxe`, so the CLI comes along on demand.
This installs the public `luxe` skill.

By default the skill lands in the current project's skills directory (`.claude/skills/`, for example).
Add `-g` to install it for all projects (`~/.claude/skills/`).

### Using it

In agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/luxe let's discuss our plan here
```

Or just ask for anything that is easier to grasp visually, such as a plan, comparison, diagram, table, code view, or report.
The agent loads the skill on its own when it recognizes the task.

### Sandbox and CI fallbacks

In restricted subprocess sandboxes, CI, or agent harnesses where `npx -y` exits opaquely, the skill also documents direct installed-copy fallbacks through the local or global npm install path.

Its frontmatter includes Hermes Agent metadata, so Hermes-compatible harnesses can categorize and surface it as a first-class productivity skill.

### The two names

The npm package is `editeur-luxe`, because the bare name `luxe` on npm is an unrelated package.
The command you type and the slash command you invoke are both `luxe`.

## Other ways to use Luxe

The skill is the recommended path, but it is not the only one.

### Zero setup

Luxe is an [AXI](axi.md), so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Use `npx -y editeur-luxe` to write a product or technical plan for what we discussed.
```

### From source

See [Development](development.md).
