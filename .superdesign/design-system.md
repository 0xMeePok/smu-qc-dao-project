# QC DAO design system

Research funding desk. Problem owners publish a brief, researchers propose, one fully funded proposal is matched, and funds release milestone by milestone.

Aesthetic archetype: a laboratory blotter. Warm newsprint, carbon ink, one cadmium signal. It should feel like a spectrograph notebook used to record money, not a SaaS marketing page.

## Forbidden

- Purple or indigo gradients on white, or any full-bleed color wash behind type
- Inter, Roboto, Arial, system-ui, SF Pro, Helvetica, and Space Grotesk
- Predictable rounded card grids, `rounded-2xl` panels, pill buttons, and a border or card around every block
- Cluttered headers: icon clusters, inset tabs, redundant eyebrows above every heading
- Even pastel palettes and uniform 96px padding on every section

## Color

- Newsprint ground: #e7dcc8
- Carbon ink: #1c140c
- Muted ink: #5c5146
- Signal (the only accent for links and the primary action): #d23a16
- Hairline: rgba(28, 20, 12, 0.18)
- One inverted band, the walkthrough only: ground #1c140c, type #e7dcc8
- Do not use the old blue page wash (#eef1f8, #0071e3) for layout chrome. Do not use mineral #d5ddd8 or verdigris #0c6b62.

## Type

- Headlines: "Newsreader", optical serif, weight 500, tight leading
- Figures, meta, and navigation: "IBM Plex Mono"
- Load both from fonts.googleapis.com
- Hero: 92px Newsreader, line-height 0.92, tracking -0.03em
- Section title: 56px Newsreader
- Body: 18px Newsreader, line-height 1.45, measure 62ch
- Meta: 12px IBM Plex Mono, uppercase, tracking 0.08em

## Space

- Content width 1080px
- Inside a group: 8px
- Between groups: 28px
- Between sections: 128px
- Radius: 0 everywhere, including workflow stamps
- Separate regions with a background shift (newsprint to carbon, or a single hairline), not with boxes

## Header

Only the logo, the wordmark QC DAO, Home, Discover, and the words "Sign in". No theme icon, no extra action icons, no tabs.

## Motion

One page-load sequence: a spectrograph rule draws beside the hero, then the headline, then the actions, using CSS animation-delay. Nothing else loops. `prefers-reduced-motion` shows the final frame.

## Workflow status badges

These are product law for color and wording, and they must look like blotter stamps, not default chips. Never a color-only dot and never a made-up label (Released, In review, Open, Complete, Proposal matched).

Shape: a square rubber stamp, radius 0, not a pill. IBM Plex Mono, 11px, uppercase, tracking 0.08em. A 3px solid bar on the left edge in the tone's text color. Outline icon in that same text color, then the official label. Padding 4px 8px 4px 6px. No shadow, no gradient, no filled circle behind the icon.

Fit: a stamp never overlaps a title, figure, or the next row. Give it its own column. The title column uses min-width 0 and may wrap. The stamp uses flex-shrink 0, max-width 100% of its column, and the label wraps to two lines when the column is narrower than the words (white-space normal, not nowrap). Long labels such as "Awaiting evaluator feedback" stay inside the stamp. On a narrow screen the stamp sits under the title with 8px between them. Do not clip the label.

Colors stay exactly these pairs (background / border / text):

- neutral #f2f2f4 / #d2d2d7 / #424245 — Draft
- info #f0f5fd / #c4d9f6 / #0062c4 — Submitted, Feedback recorded
- warning #fff5e6 / #ffd79a / #b25000 — Awaiting evaluator feedback, Selected, Pending approval, Recommend with revisions, Revision requested
- success #eaf8ee / #b8e6c4 / #248a3d — Accepted, Decision recorded, Recommend
- danger #fff1f0 / #ffc7c2 / #d70015 — Invalidated, Declined, Do not recommend
- muted #f2f2f4 / rgba(0,0,0,0.08) / #68686d — Expired, Refunded, Not progressing

Deliver example: two milestones are Decision recorded (success). The third is Awaiting evaluator feedback (warning). The hero chip is Decision recorded (success), with the proposal title as secondary text.

## Logo

Same lens-and-node mark, recolored to the blotter: cadmium square #d23a16, newsprint strokes #e7dcc8. No blue gradient.
Exact mark: https://vgbujcuwptvheqijyjbe.supabase.co/storage/v1/object/public/hmac-uploads/projects/f80543aa-8789-448b-b957-772bc86ccafa/brand-assets/frontend-src-components-ResponsiveHeader.jsx-BrandMark/qc-dao-mark.svg
Wordmark beside it: QC DAO. Do not replace the mark with initials, emoji, a generic icon, or an invented SVG.

## Pages

Home keeps: hero "Fund problems with clear outcomes.", Explore opportunities, Publish a brief, four roles, Publish / Propose / Match / Deliver, Discover, Workspaces, Open now, and the closing question.

Discover is a ledger of opportunities: title, organisation, a Submitted badge, funding, proposal count, close date. Not a card grid.

A posting is a reading page: back link, kicker, StatusBadge, title, then the problem in running text. Section changes are inline words, not a segmented tab bar.
