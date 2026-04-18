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

On top of raw pressure, structures can also **disable** each other. Every active structure has a disable meter that fills under attack and decays when left alone. When the meter fills, the structure goes offline for a few seconds, producing no pressure, then recovers. Only Rhizomorphs and Fruiting Clusters fill enemy meters; Hyphae and Decomposers don't.

**Future improvement (not MVP):** Territorial control could grant nutrient bonuses from decomposed wood, creating snowball dynamics.

### Economy

Nutrients accumulate passively over time. Starting nutrients are enough to build Hyphae or Rhizomorphs immediately, but Fruiting Bodies require a short wait. This creates the early choice: fast establishment (hyphae/rhizomorphs) or delayed power spike (fruiting bodies).

### Structures

- **Hyphal Mat** — cheap. Contributes steady pressure. No active effect — just raw, cost-efficient push.
- **Rhizomorph Node** — medium cost. Contributes moderate pressure and locks onto one enemy combat structure at a time, dissolving it by filling its disable meter. Targets the highest invested-nutrient enemy (decomposers excluded), so it naturally goes after expensive Fruiting and Rhizomorph structures over cheap Hyphae.
- **Fruiting Cluster** — expensive. Contributes base pressure while charging a surge. When the surge fires, it splashes heavy disable damage onto every active enemy combat structure (decomposers excluded) and briefly spikes the Cluster's own pressure. Incoming disable damage to the Fruiting itself slows the charge proportionally — any pressure on it delays the burst.
- **Decomposer Node** — nutrient building. Breaks down wood into usable sugars, increasing income. Slow to establish and produces no pressure while growing, creating a vulnerability window. Decomposers can be disabled too, but neither Rhizo nor Fruiting target them.

### Pressure types (the RPS)

The three combat structures form a soft rock‑paper‑scissors through cost, pressure, and targeting — not a hard type table:

- **Hyphae counter Fruiting Clusters** by cost-efficiency. A cheap swarm of Hyphae out-pressures a slow-charging Fruiting, and because Hyphae fill no disable meter, the Fruiting surge never finds a juicy high-value target to splash against (besides other combat structures the player has built).
- **Rhizomorphs counter Fruiting and each other** through value-weighted targeting. A Rhizomorph will dissolve the enemy's most expensive active combat structure first, so it's best aimed at Fruiting Clusters and upgraded Rhizomorphs — and comparatively weak against a field of cheap Hyphae.
- **Fruiting Clusters counter dense fields** by AoE burst. The burst disables every active enemy combat structure at once, which is devastating against stacks of Rhizomorphs or mixed lineups, but expensive and slow to come online.

In short: Hyphae are raw pressure on a budget, Rhizomorphs are precision disable against value, Fruiting is area disable plus a pressure spike.

*Balance philosophy: clear direction, not perfect tuning.*

### Structure lifecycle

- **Establishment:** costs nutrients, takes time, produces no pressure while growing. Only one structure per colony may be growing at a time — the build buttons gate on this.
- **Upgrade (mutation):** costs nutrients, takes time. Multiple structures can mutate simultaneously. A mutating structure produces no pressure during the process. Upgraded structures produce stronger pressure and stronger per-type effects (Rhizo dissolve rate, Fruiting charge rate and burst damage, Decomposer income bonus). Single upgrade dimension, five escalating steps (level 2 → 6), with later upgrades costing more and granting a larger jump.
- **Disabled:** when a structure's disable meter fills, it goes offline for a few seconds — no pressure, no effects — then recovers with the meter cleared. Upgrades cannot be started on a disabled structure.
- **Production:** active structures continuously contribute pressure and apply their effects. Upgraded structures contribute more.

### Player actions

- Build Hyphal Mat / Rhizomorph Node / Fruiting Cluster
- Build Decomposer Node
- Tap a structure to mutate (upgrade) it

That's it.

## UI / UX

### Orientation

Force landscape. Portrait → "rotate device" prompt.

### Pre-game menu

Before the match starts the player sees a centered panel with:

- **Spread** — starts the match (and, on mobile, kicks off fullscreen + landscape lock as part of the same user gesture).
- **Difficulty toggle** — Easy / Hard.
- **How to play** — opens a short bullet-point modal (build to push the front, only one construction at a time, upgrade pauses pressure, don't get overrun) with a **Start Tutorial** button that runs the scripted tutorial instead of a real match.

A brief "get ready" countdown plays before the first tick.

### Tutorial

Scripted, step-by-step director that spawns specific enemy structures and waits for the player to perform each action (build Hyphae, watch it mature, upgrade it, build a Rhizomorph). Info-only steps require a short dwell before a tap advances them so stray taps can't skip unread text. Ends with a summary and a pointer at the restart button for a real match.

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

The pre-game menu offers two difficulties:

- **Easy (default).** After completing an action, randomly choose a next goal from: Hyphae / Rhizomorph / Fruiting / Decomposer / Upgrade. Save nutrients until affordable, then execute. Simple weighting: mostly growth structures, occasionally decomposer, occasionally upgrade.
- **Hard.** Same action set, but the bot reads the game state each tick:
  - Forced Hyphae opener for the first couple of builds, never opens with Decomposer.
  - Only takes Decomposers when it already has combat cover and the front isn't pressing on it.
  - Counters the enemy's current composition (Fruiting vs Hyphae, Hyphae vs Rhizo, Rhizo vs Fruiting). If the counter is already affordable but the bot was saving for something pricier, it buys the counter instead of sitting on nutrients.
  - Under pressure (front advanced or HP low) it never saves for the ideal structure — it buys the strongest combat structure it can afford right now, and stops spending nutrients on upgrades.
  - When no slot is free, upgrades the highest-impact structure it can (Fruiting > Rhizo > Hyphae; a single Decomposer upgrade is fine, no more).

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
