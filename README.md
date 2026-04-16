# Sporefall

Browser autobattler where two rival mycelial colonies fight for a fallen log.
See [`SPEC.md`](./SPEC.md) for the design.

## Stack

- TypeScript
- [Phaser 3](https://phaser.io/)
- Vite (dev server + build)
- Cloudflare Pages (static hosting)

The simulation (`src/game/`) is pure TypeScript with no Phaser dependency, so
it can be reused later for multiplayer (host-authoritative over WebRTC or a
Cloudflare Worker).

## Develop

```
npm install
npm run dev
```

Then open the printed URL. Build buttons are at the bottom; tap a grown
structure to spend nutrients and mutate it. Press `R` after a match to
restart.

## Build

```
npm run build
```

Output goes to `dist/`.

## Deploy to Cloudflare Pages

Connect the repo in the Cloudflare Pages dashboard and use:

- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `20` (Pages default is fine)

No server, no env vars for the MVP.
