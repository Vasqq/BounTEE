---
version: alpha
name: BounTEE Graphite
description: Dark, true-neutral graphite with NEAR green as the only colour for "proven". Taken from the locked landing page (landing C3, Nov 6 2026) and extended to the web app's working screens.
colors:
  primary: "#eceeef"
  ground: "#121213"
  ground-2: "#181819"
  surface: "#1f2021"
  line: "#2e2f30"
  line-2: "#424345"
  ink: "#eceeef"
  ink-2: "#b9bbbc"
  ink-3: "#919395"
  ok: "#00ec97"
  ok-ink: "#222425"
  ok-wash: "rgba(0, 236, 151, 0.12)"
  fail: "#ff6b6b"
  fail-wash: "rgba(255, 107, 107, 0.12)"
  warn: "#f5b83d"
  warn-wash: "rgba(245, 184, 61, 0.12)"
  term: "#0e0f0f"
  nav-solid: "rgba(18, 18, 19, 0.84)"
  float-fill: "rgba(31, 32, 33, 0.92)"
  base-blue: "#0000ff"
  arbitrum-navy: "#213147"
  arbitrum-blue-shift: "#1b4add"
typography:
  display-hero:
    fontFamily: Newsreader
    fontSize: 112.32px
    fontWeight: 360
    lineHeight: 0.98
    letterSpacing: -0.045em
  display-close:
    fontFamily: Newsreader
    fontSize: 92.16px
    fontWeight: 360
    lineHeight: 0.9
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Newsreader
    fontSize: 63.36px
    fontWeight: 360
    lineHeight: 1
    letterSpacing: -0.03em
  headline-md:
    fontFamily: Newsreader
    fontSize: 46px
    fontWeight: 360
    lineHeight: 1
    letterSpacing: -0.03em
  statement:
    fontFamily: Newsreader
    fontSize: 46px
    fontWeight: 360
    lineHeight: 1.14
    letterSpacing: -0.03em
  title:
    fontFamily: Newsreader
    fontSize: 26px
    fontWeight: 360
    lineHeight: 1
    letterSpacing: -0.03em
  title-ledger:
    fontFamily: Newsreader
    fontSize: 26px
    fontWeight: 450
    lineHeight: 1.15
    letterSpacing: -0.03em
  wordmark:
    fontFamily: Newsreader
    fontSize: 23px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: -0.02em
  body-lg:
    fontFamily: Switzer
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
  question:
    fontFamily: Switzer
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.3
  body-md:
    fontFamily: Switzer
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"tnum"'
  label-md:
    fontFamily: Switzer
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1
  body-sm:
    fontFamily: Switzer
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-sm:
    fontFamily: Switzer
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
  data:
    fontFamily: IBM Plex Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1
  data-block:
    fontFamily: IBM Plex Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
  data-strong:
    fontFamily: IBM Plex Mono
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.6
  diagram-title:
    fontFamily: Switzer
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1
  diagram-data:
    fontFamily: IBM Plex Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1
rounded:
  chip: 7px
  sm: 8px
  mini: 10px
  float: 12px
  md: 14px
  full: 999px
spacing:
  gutter: 56px
  wrap: 1320px
  nav: 68px
  section: 172.8px
  section-rest: 200px
  head-to-body: 56px
  panel-pad: 43.2px
  card-gap: 16px
  cta-gap: 12px
  chip-gap: 8px
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 48px
    padding: 0 20px
  button-primary-hover:
    backgroundColor: "#ffffff"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 48px
    padding: 0 20px
  button-secondary-hover:
    backgroundColor: "{colors.line}"
  button-nav:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 38px
    padding: 0 14px
  copy:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.chip}"
    height: 34px
    width: 76px
    padding: 0 14px
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.data}"
    rounded: "{rounded.chip}"
    height: 30px
    padding: 0 11px
  chip-hover:
    backgroundColor: "{colors.line}"
    textColor: "{colors.ink}"
  chip-proven:
    backgroundColor: "{colors.ok-wash}"
    textColor: "{colors.ok}"
  chip-mute:
    backgroundColor: "{colors.ground-2}"
    textColor: "{colors.ink-3}"
  chip-fail:
    backgroundColor: "{colors.fail-wash}"
    textColor: "{colors.fail}"
  chip-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.warn}"
  badge:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    height: 32px
    padding: 0 14px 0 11px
  terminal:
    backgroundColor: "{colors.term}"
    textColor: "{colors.ink}"
    typography: "{typography.data-block}"
    rounded: "{rounded.md}"
    padding: 18px 20px 22px
  terminal-mini:
    backgroundColor: "{colors.term}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.mini}"
    padding: 10px 10px 10px 16px
  panel:
    backgroundColor: "{colors.ground-2}"
    rounded: "{rounded.md}"
    padding: "{spacing.panel-pad}"
  dock:
    backgroundColor: "{colors.float-fill}"
    rounded: "{rounded.float}"
    padding: 5px
  dock-step:
    textColor: "{colors.ink-3}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 36px
    padding: 0 12px
  dock-step-current:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
  faq-toggle:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.chip}"
    size: 28px
  nav:
    backgroundColor: "{colors.nav-solid}"
    height: "{spacing.nav}"
---

# BounTEE design system

The locked landing page (landing C3, Nov 6 2026) is the source. Every value below is measured from its CSS at 1440 × 900. Anything marked **Extension** is for app screens the page doesn't have. It is built from the page's own parts and adds no new values unless it says so. Where the `design-taste-frontend` skill disagrees with a locked decision, the locked decision wins, and a line marked **Skill conflict** says so.

## Overview

BounTEE pays a Whitehat once an enclave proves an exploit, and pauses the covered contracts on Base and Arbitrum One. The UI exists to show that this happened, and to let anyone check it.

**Principles.** Each one decides something.

1. **Green means proven.** `ok` `#00ec97` appears only on something a chain or the Enclave has confirmed: a PAYS verdict, a payout, a landed or verified pause, a passing check, a completed step. If it isn't proven yet, it's grey. Green is never decoration, never a brand fill, and never on a button. Red (`fail`) means a check failed or a read failed. Amber (`warn`) means the Protocol must act before it matters (low pause gas). Each hue keeps its one meaning, and an object carries at most one hue.
2. **Data is shown as data.** A transaction, command, address, hash or bounty id is set in IBM Plex Mono inside a chip, terminal or diagram tag, and links to its explorer. Everything else uses the text face. A value the page can't read from a chain isn't shown (R15.6).
3. **Tone and space separate things, not lines.** Surfaces step from `ground` to `ground-2` to `surface`. The only lines are inside the terminal and between FAQ items.
4. **Sober and exact.** One ink action per view, no glow, no emoji, no adjectives that a number could replace. The serif display carries the voice. The UI chrome stays quiet.
5. **Mainnet only.** Every proof is a mainnet transaction (ADR-0017). Only chains BounTEE can pause are named: NEAR, Base, Arbitrum One.

**Scope.** Dark only (`color-scheme: dark`). Desktop and phone are both supported. Review at 1440 × 900 first, then 390 × 844. Phone rules are under Layout.

## Colors

| Token | Value | Use |
| --- | --- | --- |
| `ground` | `#121213` | Page background. |
| `ground-2` | `#181819` | Panels on the ground (the "You, or your agent." columns), muted chips. |
| `surface` | `#1f2021` | Secondary buttons, chips, Copy, the FAQ +, badge. |
| `line` | `#2e2f30` | Hover fill of `surface` controls. As a line: only the terminal frame and FAQ rules. |
| `line-2` | `#424345` | The badge's inset ring, the dock's 1px edge, diagram tag outlines, hairline link underlines. |
| `ink` | `#eceeef` | Headings, body text, the primary button fill. `primary` in the front matter is `ink`. |
| `ink-2` | `#b9bbbc` | Leads, paragraphs under headings, nav links, chip text. |
| `ink-3` | `#919395` | Meta, labels, step numbers, WAIT, footer. |
| `ok` | `#00ec97` | Proven, and nothing else (Principle 1). Also the 2px focus ring and the text selection, as on the page. |
| `ok-ink` | `#222425` | Text on an `ok` fill (selection). |
| `ok-wash` | `rgba(0, 236, 151, 0.12)` | Fill of a proven chip or tile. |
| `fail` | `#ff6b6b` | **Extension.** FAIL in Verify, a failed read. Contrast 6.75:1 on `ground`, 5.77:1 on its wash. |
| `fail-wash` | `rgba(255, 107, 107, 0.12)` | **Extension.** Fill of a fail chip. |
| `warn` | `#f5b83d` | **Extension.** The low pause-gas warning only. Contrast 10.5:1 on `ground`, 8.42:1 on its wash. |
| `warn-wash` | `rgba(245, 184, 61, 0.12)` | **Extension.** Fill of the warn chip and the warning block. |
| `term` | `#0e0f0f` | Terminal and command-block background. It is a literal on the page, not a variable. |
| `nav-solid` | `rgba(18, 18, 19, 0.84)` | Nav bar once scrolled more than 8 px, with a 12px backdrop blur. |
| `float-fill` | `rgba(31, 32, 33, 0.92)` | The dock, with a 12px backdrop blur. |
| `base-blue` | `#0000ff` | The Base block and the Base Square only. |
| `arbitrum-navy` / `arbitrum-blue-shift` | `#213147` / `#1b4add` | The Arbitrum One block, its ledger lines and the wordmark hexagon only. |

Rules:
- Chain colours belong to the chains' own marks and blocks. They are never UI colours.
- Literals the page uses once: `#ffffff` (primary button hover), `#58595b` (unlit words in the landing statement), and the diagram materials (see The isometric world).
- `fail` and `warn` copy `ok`'s pattern: the hue for the text, the same hue at 12% for the fill. They go on the word or the chip that states the problem, never on a whole panel's text, a button, or a border.

## Typography

Three faces, locked: **Newsreader** (display, Google Fonts, `opsz` 6–72, `font-optical-sizing: auto`), **Switzer** (text, Fontshare 400/500/600/700), **IBM Plex Mono** (data only, 400/500). The body sets `font-variant-numeric: tabular-nums` everywhere. **Skill conflict:** the skill allows two typefaces and no monospace. Three faces and mono-for-data are locked.

| Token | Face / weight | Size at 1440 (CSS) | Leading | Tracking | Where |
| --- | --- | --- | --- | --- | --- |
| `display-hero` | Newsreader 360 | 112.32 (`clamp(80px, 7.8vw, 120px)`) | 0.98 | -0.045em | Landing hero only |
| `display-close` | Newsreader 360 | 92.16 (`clamp(48px, 6.4vw, 104px)`) | 0.9 | -0.03em | Landing close only |
| `headline-lg` | Newsreader 360 | 63.36 (`clamp(36px, 4.4vw, 64px)`) | 1 | -0.03em | Section `h2` |
| `headline-md` | Newsreader 360 | 46 (`--fs-h3: clamp(32px, 3.2vw, 46px)`) | 1 | -0.03em | Step panel `h3` |
| `statement` | Newsreader 360 | 46 (`--fs-h3`) | 1.14 | -0.03em | Landing statement only |
| `title` | Newsreader 360 | 26 (`--fs-4`) | 1 | -0.03em | Panel `h3` |
| `title-ledger` | Newsreader 450 | 26 (`--fs-4`) | 1.15 | -0.03em | Ledger item titles |
| `wordmark` | Newsreader 500 | 23 | 1 | -0.02em | "BounTEE" in the nav |
| `body-lg` | Switzer 400 | 20 (`--fs-lead`) | 1.5 | 0 | `.lead`, hero subtext; `ink-2`, max 36em |
| `question` | Switzer 500 | 20 (`--fs-lead`) | 1.3 | 0 | FAQ question |
| `body-md` | Switzer 400 | 18 | 1.5 | 0 | Body |
| `label-md` | Switzer 500 | 16 (`--fs-ui`) | 1 | 0 | Buttons, nav links, step numbers in panels |
| `body-sm` | Switzer 400 | 14 (`--fs-sm`) | 1.5 | 0 | Proof list, fine print, footer |
| `label-sm` | Switzer 500 | 14 (`--fs-sm`) | 1 | 0 | Small buttons, Copy, dock, badge, ledger group heads |
| `data` | Plex Mono 400 | 14 (`--fs-sm`) | 1 | 0 | Chips, command blocks |
| `data-block` / `data-strong` | Plex Mono 400 / 500 | 14 (`--fs-sm`) | 1.6 | 0 | Terminal body / PASS, WAIT |
| `diagram-title` / `diagram-data` | Switzer 700 / Plex Mono 400 | 13 / 11 | | | Inside isometric tags only (SVG units) |

Rules:
- Headings: `text-wrap: balance`. Paragraphs: `text-wrap: pretty`, max 32–36em.
- **App screens (Extension):** the page title is `headline-md` (46px). `display-*`, `headline-lg` and `statement` are for the landing page only. The largest figure on a working screen is `title` (26px).
- Italic: the CSS keeps `h1 em, h2 em { italic, 300 }`, but the locked page uses no italic. Don't add any.
- Mono is for strings a machine reads: commands, tx hashes, addresses, account ids, code hashes, the bounty id, terminal output, diagram states. Amounts and dates in running text use Switzer with tabular figures ("10 USDC", "1 USDC minimum theft").

## Layout

| Token | Value at 1440 | CSS |
| --- | --- | --- |
| `wrap` | 1320px max | `.wrap` centred, padded by `gutter` |
| `gutter` | 56px | `clamp(16px, 4vw, 56px)` |
| `nav` | 68px | fixed, z 30; anchors offset by 80px `scroll-padding-top` |
| `section` | 172.8px | `clamp(120px, 12vw, 180px)` top padding (`clamp(112px, …)` on trust and FAQ) |
| `section-rest` | 200px | `clamp(120px, 14vw, 200px)`: statement padding, close margin |
| `head-to-body` | 56px | heading block to its content; 48 (ledger), 40 (verify) are also used |
| `panel-pad` | 43.2px | `clamp(28px, 3vw, 44px)` |
| `card-gap` | 16px | between peer panels |
| `cta-gap` / `chip-gap` | 12px / 8px | button rows / chip rows |

- Section heads are a two-column grid, about `1.3fr 1fr` with a 40px gap: the `h2` on the left, the lead on the right, aligned to the bottom (`align-items: end`).
- Every section uses a different composition. None is a card grid.
- **App screens (Extension):** same `wrap` and `gutter`, under the same 68px nav. No sidebar: the app has five pages, so it uses the skill's "no sidebar" shell. The page title starts 56px below the nav (`head-to-body`). Blocks inside a screen are separated by 40px. On the posting flow, the form column and the "what you're risking" panel sit side by side as `1.3fr 1fr`, the same split as the section heads.

**Phone.** The page's breakpoints hold everywhere:
- **Below 1080px:** the nav links hide.
- **Below 900px:** every two-column grid becomes one column, and the right-hand column stacks under the left. Step-panel `h3` drops to 30px. The terminal's result rows become `6ch 1fr`, with the detail moving under the name. The dock keeps only the current step's label.
- **Below 560px:** the nav spreads its items across the bar (`space-between`).
- `gutter` bottoms out at 16px, and the display clamps reach their minimums.

**Extension** (app screens on a phone):
- The app bar keeps the wordmark, "Bounties" and the action at every width. "Verify" hides below 560px.
- Bounty list rows become two lines (below).
- Chips wrap in their row and are never squeezed.
- Every tap target is at least 44px tall, using padding or a hit area if the drawn control is smaller.
- Pages that show the dock add bottom padding equal to the dock's height plus 20px, so the dock never covers the last control.

## Elevation & Depth

- Flat. Depth comes from tone steps: `ground`, then `ground-2`, then `surface`, then `line` on hover.
- **Float** shadow, used only on things that truly float: the dock and the hero's tiles.
  `0 1px 0 rgba(255,255,255,.04) inset, 0 1px 2px rgba(0,0,0,.35), 0 8px 24px rgba(0,0,0,.35), 0 24px 60px rgba(0,0,0,.3)`.
- Backdrop blur (12px) only on the solid nav and the dock. **Skill conflict:** the skill bans glass and shadows. The floating dock and the nav blur are kept by Liam.
- **Extension:** the posting flow's dock is the app's only floating element. Nothing else gets a shadow or blur.

## Shapes

| Token | Value | Used on |
| --- | --- | --- |
| `chip` | 7px | chips, Copy, FAQ + |
| `sm` | 8px | buttons, dock steps |
| `mini` | 10px | inline command block |
| `float` | 12px | dock |
| `md` | 14px | panels, terminal |
| `full` | 999px | the hero badge and the story's step pill only |

Focus: a 2px `ok` outline with a 3px offset and a 6px radius. **Skill conflict:** the skill wants buttons square or fully round. The page's 8px is locked.

## Motion

| Name | Value | Used for |
| --- | --- | --- |
| `--ease` | `cubic-bezier(0.23, 1, 0.32, 1)` | every transition (one curve) |
| `--t1` | 160ms | press scale, link colour, FAQ + press |
| `--t2` | 240ms | fills, panel swap, dock show, FAQ open (`grid-template-rows` 0fr to 1fr), terminal lines |
| 420ms | | isometric parts moving, the hero's third line |
| 600ms | | `.rise` reveal: 14px up plus fade, staggered by `--d` (80, 120, 140ms) |
| 700ms | | chain block tint to muted on pause |

- Press: `transform: scale(0.97)` on buttons, Copy and dock steps; 0.9 on the FAQ +.
- Terminal results reveal one line at a time: a 120ms start, then 140ms between lines.
- Copy shows "Copied" for 1600ms.
- `prefers-reduced-motion`: every duration drops to 1ms, the pulses stop, and everything is shown at once.
- **Extension:** live data never animates in. A value that changes swaps in place, with a 240ms colour change when it becomes proven.

## Components

### From the page

**Buttons.** `button-primary` is the ink fill; one per view. `button-secondary` is a `surface` fill. Both are 48px tall with 20px side padding. `button-nav` is the 38px version. No outlines, no icons, no arrows. Labels are verbs: "Verify it yourself", "Post a bounty", "Open the app".

**Nav bar.** Fixed, 68px, transparent over the hero, then `nav-solid` with blur after 8px of scroll. It holds the wordmark (a 24px hex-and-bars mark plus "BounTEE" in `wordmark`), links in `ink-2` 16px spaced 26px apart (`ink` on hover), and one `button-nav` on the right. No divider line. **Extension:** on app screens the links are "Bounties" (the list) and "Verify" (the landing page's Verify section), and the action is "Post a bounty". The current page's link turns `ink`. The landing page keeps its own links and "Open the app", which goes to Bounties.

**Testnet badge (Extension, D31).** On the testnet site only, "Testnet" sits 12px (`cta-gap`) right of the wordmark: the `chip`'s shape and fill (`surface`, `chip` radius, 30px tall, 0 11px) with `label-sm` in `ink-2`, since it is a word, not data. It links to the mainnet site, with `chip-hover`; with no mainnet address set it is plain text. It is the only mark of the testnet site, and the testnet nav's Verify goes to the mainnet site's Verify section. The mainnet site links back with a quiet "Try it on testnet" (`body-sm`, `ink-2`), under the bounty list and among the landing footer's links.

**Chips** (30px tall, `data`, `chip` radius, `flex: none; white-space: nowrap`):
- Transaction: two chips side by side, the chain name (`chip`) and the link (`a.chip`, hover `chip-hover`), with an 11px external-link glyph. Until the transaction exists the link reads "tx pending" and points at the explorer root (nearblocks.io, basescan.org, arbiscan.io).
- **Extension:** once the transaction exists, the link chip shows its shortened hash (the first 6 characters, "…", the last 4: `0x8f3a…9b2c`, `8Fq3Zk…9xKp`) and links to that transaction on the chain's explorer. The full hash is the link's `title`. After the external glyph, inside the same chip, sits a 12px copy glyph as its own `button` (accessible name "Copy transaction hash", `ink-3`, `ink` on hover). It copies the full hash. For 1600ms it swaps to a check in `ink` and announces "Copied" through an `aria-live` region. The copy action is never green, because copying proves nothing.
- Verdict or amount: `chip-proven`, e.g. "Verdict PAYS", "10 USDC", "2 of 2 verified".
- Not yet / not counted: `chip-mute`, e.g. "pending · after 1 day", "Cheat claim: ZERO".

**Terminal.** `term` background, a 1px `line` frame, `md` radius. A bar on top holds `$ command` (the prompt in `ink-3`, not selectable) and Copy, over a 1px `line` rule. The body holds a note in `ink-3`, then results as a grid `6ch | 1.05fr | 1fr`: status, name (`ink`), detail (`ink-3`, links `ink-2`). Rows are separated by 1px dashed `line`. After them comes a summary line over a 1px `line` rule, e.g. "**6 passing**, 1 not yet published." with the count in `ok`.

**Command block** (`terminal-mini`): a single line of `$ command` plus Copy, on `term`, used inside panels.

**Verify check list.** The terminal body. PASS is `data-strong` in `ok`. WAIT is `data-strong` in `ink-3`, with a reason ("not yet published · after 1 day"). Seven checks from R15.1, in the page's order. **Extension:** FAIL is `data-strong` in `fail`, with what didn't match in the detail column ("code hash differs from source"). The summary counts failures first ("**1 failing**, 5 passing, 1 not yet published."), with the failing count in `fail`.

**Step panels and the dock.** Steps are numbered "1." to "8.". In a panel the number is `label-md` in `ink-3`, raised 0.5em before the `headline-md` title. The dock floats 20px from the bottom and shows only while its track is in view. Each step is number + label. Done steps turn their number `ok` and their label `ink-2`. The current step is inverted (`ink` fill, `ground` text, number at 60% opacity). Below 900px only the current step keeps its label.

**Proof list.** A `dl` in a two-column grid (`auto 1fr`, 6px × 18px gaps), `body-sm`. Terms in `ink-3`, values in `ink-2`, proven values in `ok`.

**Ledger.** Two columns. Group heads are `label-sm` in `ink-3`. Items are a 52px isometric glyph plus a `title-ledger` title and an `ink-2` sentence, with 18px padding and no dividers.

**FAQ disclosure.** A 1px `line` rule above and below each item. The question is `question` with 22px vertical padding. On the right, a 28px `surface` square holding a 10px +, which turns 45° when open. Answers are `ink-2`, max 36em.

**Badge.** The hero's "Built on NEAR" pill: NEAR mark in `ok`, `label-sm`. It is the only eyebrow (locked). **Skill conflict:** the skill bans eyebrows.

### For the app (Extension)

**Status chip** (one per bounty, from the chip variants): "Live" is `chip`; "Paid" is `chip-proven`; "Ended, unclaimed" and "Withdrawn" are `chip-mute`. A claim in progress has no state and is never shown (R7.7).

**Bounty list.** A plain `<table>` in `wrap`, with no sorting, filters or pagination. Show the total above it ("3 bounties"). Header row is `label-sm` in `ink-3`, sentence case, no rule, no fill. Each row is a `ground-2` fill with `sm` radius, 56px tall, 2px apart, hover `surface`. There are no row lines (Principle 3). Columns:
- Bounty: `protocol/name` in `data` `ink`. It is the widest column and links to the bounty page.
- Covered chains: 16px chain marks.
- Bounty amount and Minimum theft: right-aligned, tabular, "10 USDC".
- Ends: ISO date, right-aligned.
- State: the status chip.

On a phone each row becomes two lines, 72px tall: the bounty and its status chip on line 1; amount · ends · chain marks on line 2, in `body-sm` `ink-2`.

**Bounty page.** Title is `headline-md` (`protocol/name`) plus the status chip. Below it a proof list: Bounty amount, Minimum theft, Ends, Claims judged (D22). Then, in order:
- Rules in plain English and What doesn't pay: `body-md` paragraphs in a `panel`.
- Pause, per chain (below).
- Verify: the terminal, with `bountee verify <protocol>/<name> --network mainnet` in its bar and the checks read live in its body.

**Per-chain pause state.** One `panel` row per covered chain: chain mark and name, then three steps written like the dock, "1. Signed", "2. Landed", "3. Verified". Each step's number turns `ok` only once that fact is on chain (R7.7). Each finished step carries its transaction chip pair. When a pause is signed but hasn't landed, the row shows `button-primary` "Send pause" (R7.9; no wallet). While it sends, the label reads "Sending" and the button is disabled. Once sent, the tx chip appears and "2. Landed" waits for the receipt.

**Low pause-gas warning** (D8). A `warn-wash` block with `sm` radius and 16px padding, inside the affected chain's row. It opens with a `chip-warn` "Low pause gas". Under it, one `body-sm` sentence in `ink` gives both numbers, read live, in the form "Pause gas on Base: <held> ETH. The signed pause needs <needed> ETH. Top up the pause-role address." The address follows as a command block with Copy.

**Forms** (posting flow, open-exploit). Label above the field, `label-sm` in `ink-2`, 8px gap. The field is a `surface` fill with no border, `sm` radius, 48px tall to match the buttons, `body-md` text in `ink`, and the 2px `ok` focus ring. Fields are 16px apart. Help text is `body-sm` in `ink-3` under the field. Addresses and ids are typed in `data`. Disabled controls stay legible and say why in a line beneath.

**Posting flow** (#31). The flow's steps are the dock's steps: the dock floats at the bottom and moves between them, with done steps' numbers turning `ok` only once their transaction lands. The exact step list is settled with Liam when #31 starts. Field and checklist rules below apply whatever the steps are. The coverage limit (R4.12) is one `body-sm` `ink-2` sentence under the covered-contracts field: "Only contracts that pay nothing to callers by design can be covered."

**Posting checklist** (D5, D14, D17, D20). Numbered items "1." onward, laid out like the per-chain pause rows. Each item has:
- Its number, which turns `ok` once the item lands on chain.
- A `title`.
- The explanation in `ink-2`. The pause-gas text is D5's, word for word in meaning.
- A primary action, e.g. "Grant on Base".
- "Copy for your multisig" as `button-secondary`.
- The tx chip once it lands.

The NEAR step shows the Protocol's `0x…` account in a command block with Copy. The exploit-key step's action is "Sign with MetaMask". If the two signatures differ, the item shows one `ink` sentence saying so and offers a key-file field in its place (D20).

**"What you're risking" panel** (D15). A `panel` in the right column, built as the ledger without glyphs: `title-ledger` items, each with one sentence, listing D15's points and the R15.5 trusted parties. It stays in view beside the final two prompts. On a phone it sits directly above the two prompts.

**Open-exploit page** (#32). Before payout, one sentence: "This exploit opens once the Whitehat is paid." After payout, `button-primary` "Open with MetaMask". The opened exploit shows in a terminal with Copy, followed by the line: "Unpausing is up to your own governance."

**Empty, loading, error.**
- Empty keeps the block's frame and heading and adds one `ink-2` sentence ("No bounties are live.").
- Loading keeps the final layout, with each value replaced by a flat `surface` bar of its real height. No shimmer, and no layout shift when the data lands.
- Error appears inside the block that failed: a `chip-fail` naming what failed ("Couldn't read Base"), one `ink-2` sentence saying when the data was last good, and a `button-secondary` "Retry". Never a full-page banner.
- A real zero is printed ("0 claims judged"). A missing value is an `ink-3` en dash.

## The isometric world

**When.** On the landing page only: the story, the trust glyphs, the "You, or your agent." glyphs, and the close. The app's own screens (list, bounty page, posting flow, open-exploit) don't draw it. Whether the bounty page should is still open (see Open questions).

**Projection.** `K = cos 30°`, `S = 20` px per unit. A point `(x, y, z)` maps to `[(x − y)·K·S, ((x + y)/2 − z)·S]`. SVG only, sized with `viewBox` and fit to the bounding box plus 12px (2px for glyphs). Text on a face uses the face's matrix (`onTop`, `onLeft`, `onRight`).

**Primitives.**
- `box`: three faces, plus a highlight on the near edge at `rgba(255,255,255,.2)`, 0.8px wide.
- `cyl`, `sphere`, and `pad`: a 1px floor outline, `#444547`, which turns `#00ec97` when that object is proven.
- `bus`: 2–3 parallel 1px traces, `#333435`, `#858688` when active, with via dots.
- `field`: a seeded circuit of `#262728` traces, fading out radially, with `#858688` pulses at 55% opacity, 5–10s each.
- `lock`, `packet` (sealed, coin, pause, ok, plain), and `groundText` (Switzer 13/500 `ink-3`).

**Materials** (top / left / right faces):

| Material | Top | Left | Right | Is |
| --- | --- | --- | --- | --- |
| bone | `#dfe1e3` | `#b6b7b9` | `#8d8f90` | the Enclave, sealed things |
| stone | `#414244` | `#303132` | `#252627` | bases, the bounty vault |
| graph | `#5b5c5e` | `#444547` | `#343536` | machines, the MPC nodes, the agent |
| clay | `#afb0b2` | `#8f9092` | `#6d6f71` | the person |
| ok | `#4cf0a3` | `#25bd7b` | `#03965f` | proven things only: coins, the pause lid, signatures |

Screens and panels on objects are `#19191a`.

**Tags.** A rounded rect (radius 7) with a 6px pointer, fill `rgba(24,24,25,.94)`, 1px `#424345` outline. The title is `diagram-title` in `ink`. The state below it is `diagram-data`: `ink-3` normally, `ink-2` while acting (outline `#727375`), `ok` once proven (outline `rgba(0,236,151,.55)`). A 3px dot at the right repeats the colour. States are lowercase data: "10 USDC locked", "verdict PAYS", "paused · verified".

**Chains and the pause.**
- A live chain block wears its brand colours. Base faces are `#0000ff`, `#0000d0`, `#0000a2`, with `#3c8aff` ledger lines. Arbitrum One faces are `#213147`, `#1a2739`, `#131d2b`, with `#1b4add` lines.
- When its pause lands, the faces and lines mute to grey over 700ms: `mute(c) = (c·0.08 + L·0.92)·0.42 + 30·0.58` per channel, where `L` is the Rec. 709 luma.
- Then a green `ok` lid drops 26px onto the block, carrying two `#00653e` pause bars, and the pad turns green.
- A block shows paused only once the pause has landed. "Verified" is a tag state, set only once NEAR records it (R7.7).

**Brand marks.**
- **Base:** the official Square, unaltered: white on the Base Blue block, and in blue, white or black only. No effects, no transparency.
- **Arbitrum One:** the official all-white logomark on Navy, unaltered, with no drop shadow.
- **NEAR:** the N mark in white, as near.org draws it, on the bounty contract and the MPC slab. NEAR green marks proofs.
- **Wordmarks on dark:** `Base_lockup_blue_dark.svg` and `Arbitrum_One_horizontal_blue_dark.svg`. These are Liam's colour versions; neither kit ships them. The compliant alternative is the full-colour primaries on a light tile.
- Sources and caveats are recorded in `BRAND-SOURCES.md` beside the landing page. Never draw or name a chain BounTEE can't pause.

## Voice and copy

- Sentence case everywhere, buttons included. No eyebrows, except the locked hero badge "Built on NEAR".
- No emoji. No "!" in UI text. No marketing adjectives.
- Roles are capitalised as in `GLOSSARY.md`: Protocol, Whitehat, Verifier, Enclave, MPC network. The Whitehat is the role, and the AI agent is how one acted: "a Whitehat's AI agent, with a claim key". Payouts go to the Whitehat, never to a key.
- Step numbers are written "1." "2." "3.", never "01", never "Step 2".
- Transactions are written as a chain chip plus a link. Once the transaction exists, the link shows the shortened hash and has a copy button. Before then, it says "tx pending" and points at the explorer root: nearblocks.io for NEAR, basescan.org for Base, arbiscan.io for Arbitrum One. Pending states give their reason after a middle dot: "pending · after 1 day".
- Chain names are written in full: "Arbitrum One", never "Arbitrum" or "Arb". Amounts are written "10 USDC". Chains are listed as "NEAR, Base and Arbitrum One".
- "Paused" means the pause transaction succeeded on that chain. Use "verified" only for what NEAR's MPC network confirmed. Never imply anything about the contract's code.
- Mainnet only. No "testnet", "Sepolia", "rehearsal" or network toggle in any mainnet build. The network is a build setting, not a control. D17's faucet link exists only in the testnet build, the second site for trying BounTEE (ADR-0021).
- Wallets: "Posting connects MetaMask. Reading and verifying never do." No wallet prompt on public pages.

## Do's and Don'ts

| Don't | Do instead |
| --- | --- |
| Hairline dividers between sections, rows, nav, footer or columns | A tone step (`ground-2` panel) or space. Lines only inside the terminal and the FAQ list. |
| Outlined or dashed chips and buttons | Filled: `surface`, `ok-wash`, `ground-2`. |
| Arrows or icons in buttons | The verb alone. The only glyphs are inside tx chips: the 11px external link and the 12px copy. |
| Red or amber on anything but the failing or low fact | `fail` and `warn` on that one word or chip; the rest of the block stays ink. |
| Mono for labels, step numbers, cues, headings | Switzer. Mono only for machine-readable data. |
| Green on a button, a link, a heading accent or anything not yet proven | `ink` for actions; green only once proven. The hero's "paid." is the one locked exception. |
| Glows, neon, coloured shadows | Tone steps. The float shadow only on what floats. |
| Gradients | Flat fills. Locked exceptions: the hero background's fade and the hero cue line. |
| New font sizes | The scale above. |
| "01", "Step 2", "(001)" | "1." |
| Showing a claim in progress, or "landed" or "verified" before the chain says so | The R7.7 states, read live. |
| Typed or hard-coded values shown as fact | Read from the chain (R15.6). |
| Solana or any chain BounTEE can't pause | NEAR, Base, Arbitrum One. |
| Skeleton shimmer, full-screen error banners, emoji in empty states | Flat bars at real size; one sentence in the failed block. |

## Open questions

1. **Isometric world on the bounty page.** Liam is open to it but undecided. Until then the bounty page doesn't draw it. If it's wanted, try A/B/C variations as a throwaway prototype first, not in the app.
2. **Posting flow steps.** The dock moves between them (decided). The exact steps and their order get settled when #31 starts.
