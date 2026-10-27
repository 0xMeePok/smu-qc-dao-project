# Architecture diagrams

Image exports of the diagrams in the handover book, for slides and reports.

| File | Diagram |
| --- | --- |
| `system-architecture.png`, `.svg` | Components and how they talk to each other |
| `sign-in-sequence.png`, `.svg` | Privy email sign-in and the Firebase session exchange |

The source of truth is the Mermaid code in [`gitbook/overview/architecture.md`](../../gitbook/overview/architecture.md). GitBook and GitHub render it directly. After editing it, regenerate these files with the commands in that page's **Regenerating the exports** section. `mermaid-config.json` sets the export font and colours.
