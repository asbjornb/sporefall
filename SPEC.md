# Sporefall — MVP Spec

## Core idea

Two rival mycelial colonies grow from opposite ends of a fallen log, competing to decompose it and destroy the other's heart.

Each colony accumulates nutrients over time and invests them in specialized growth structures. These structures continuously push hyphal advances outward — waves of fungal power flowing down the log, meeting the enemy's advances in the middle and struggling for territory. There is no direct control of growth.

Strategy comes from:

- build order
- timing
- nutrient economy vs territorial pressure
- structural composition (hyphae / rhizomorphs / fruiting bodies)

## MVP goal

Playable single-player browser prototype with:

- one human player
- one AI opponent
- one log (single lane)
- fixed structural slots near each sclerotium
- 3 growth types
- 1 nutrient structure
- structural upgrades
- automatic territorial combat

## Platform

Browser. Mobile-friendly. Landscape required. Desktop supported.

## Core rules

### Map

A single horizontal fallen log. Your sclerotium (heart) anchors the left end; the enemy's anchors the right. Growth structures occupy fixed slots near each heart. No placement mechanic. The log itself is the battlefield — and it visibly changes color as each colony's influence pushes across it.

### Win condition

Destroy the enemy sclerotium.

### Combat behavior (MVP)

Rather than discrete units marching, each colony continuously exerts territorial pressure along the log. Each active growth structure contributes a steady flow of pressure outward. Where the two colonies' pressures meet, a contested front forms — a visible seam of struggling, intermixed mycelium.

The front shifts toward whichever side currently has more pressure. When a colony's pressure reaches the enemy sclerotium, it begins damaging it.

Think of it as two tides of color pushing against each other, the boundary flowing back and forth as each side builds, loses, or upgrades structures. Waves of accelerated growth periodically pulse outward from each structure — these are the "attacks," visible as brighter surges along the front.

**Future improvement (not MVP):** Territorial control could grant nutrient bonuses from decomposed wood, creating snowball dynamics.

### Economy

Nutrients accumulate passively over time. Starting nutrients are enough to build Hyphae or Rhizomorphs immediately, but Fruiting Bodies require a short wait. This creates the early choice: fast establishment (hyphae/rhizomorphs) or delayed power spike (fruiting bodies).

### Structures

- **Hyphal Mat** — cheap. Produces thin hyphal pressure: fast-spreading, smothering.
- **Rhizomorph Node** — medium cost. Produces enzymatic pressure at range: dissolves enemy growth from a distance.
- **Fruiting Cluster** — expensive. Produces sporulation surges: devastating bursts that colonize enemy territory faster than it can respond.
- **Decomposer Node** — nutrient building. Breaks down wood into usable sugars, increasing income. Slow to establish and produces no pressure while growing, creating a vulnerability window.

### Pressure types (the RPS)

- **Hyphae > Fruiting Bodies** — swarming threads smother mushrooms before they mature.
- **Rhizomorphs > Hyphae** — enzymatic cords dissolve thin hyphae at range.
- **Fruiting Bodies > Rhizomorphs** — spore clouds colonize enzymatic zones faster than rhizomorphs can break them down.

Hyphae remain the cost-efficient counter to Fruiting Bodies.

*Balance philosophy: clear direction, not perfect tuning.*

### Structure lifecycle

- **Establishment:** costs nutrients, takes time, produces no pressure while growing.
- **Upgrade (mutation):** costs nutrients, takes time. Multiple structures can mutate simultaneously. A mutating structure produces no pressure during the process. Upgraded structures produce stronger pressure. Single upgrade dimension in MVP.
- **Production:** active structures continuously contribute pressure. Upgraded structures contribute more.

### Player actions

- Build Hyphal Mat / Rhizomorph Node / Fruiting Cluster
- Build Decomposer Node
- Tap a structure to mutate (upgrade) it

That's it.

## UI / UX

### Orientation

Force landscape. Portrait → "rotate device" prompt.

### Layout

- **Top bar:** nutrients, income rate, (optional) sclerotium HP
- **Center:** the log, with flowing territorial colors and active growth structures at each end
- **Bottom:** large build buttons

### Interaction

Tap a structure → mutation option.

### Camera

Entire log fits on screen. No scrolling initially.

### Visual direction

Autumnal palette — deep russets, ochres, amber, moss green, rotting browns — with accents of purple and silver for otherworldly effect. Purple for fruiting-body surges and bioluminescent sporulation; silver for rhizomorph enzymatic glints and the shimmer along contested fronts. The log itself is rendered warmly, naturalistically. The fungi are where the stylization lives: slightly hypnotic, slightly unsettling, beautiful. Contested seams where the two colonies meet should feel like they're fighting — boiling, writhing, alive.

Pressure waves pulse outward as soft color surges rather than discrete sprites. Structures are ornate, organic, and visibly change appearance with upgrades (more elaborate fruiting caps, denser rhizomorph cords).

## AI opponent

MVP bot behavior:

- After completing an action, randomly choose a next goal from: Hyphae / Rhizomorph / Fruiting / Decomposer / Upgrade. Save nutrients until affordable, then execute. Repeat.
- Simple weighting: mostly growth structures, occasionally decomposer, occasionally upgrade.

## Technical goals

- Deterministic simulation
- Simple game loop
- No multiplayer yet
- No accounts or backend

## Success criteria

Prototype succeeds if:

- player can build all structure types
- pressure flows and territorial struggle are legible
- mutations pause production meaningfully
- early nutrient choice feels meaningful
- AI completes full matches
- game creates tension between greed (decomposer) and survival (pressure structures)

## Design principles

Minimal input, maximum consequence. Clear tradeoffs. Mobile-first. Fast iteration. Easy to extend.

## Short pitch

Mycelia is a mobile-friendly browser autobattler where two rival fungal colonies grow across a fallen log. You invest nutrients in specialized growth structures — each sending waves of pressure outward — and win by letting your colony consume the enemy's heart. No units to control, only what to grow, when to expand, and when to risk feeding. Colors flow, fronts shift, and the log itself becomes a living battlefield.
