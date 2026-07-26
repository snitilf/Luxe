# Built as an AXI

Luxe is an [AXI](https://axi.md), an agent-facing command line interface.
In practice that means three things.

**It is just a CLI any capable agent can run without setup.**
There is nothing to configure, no server to stand up, and no SDK to import.
`npx -y editeur-luxe` is enough.

**It is optimized for agent ergonomics.**
TOON output, long polling, and contextual disclosure make it highly token efficient, so a review loop costs the agent far less context than pasting screenshots or restating the artifact in chat.

**The skill only handles discovery.**
Agents learn to use the AXI by using it.
The [skill](install.md) exists so an agent knows Luxe is there and what it is for; everything past that comes from the CLI's own output.
