# Sporefall — Multiplayer Spec

Status: planned. Replaces the "No multiplayer yet" line in SPEC.md once shipped.

## Goals

- 2 human players over the internet, browser-only.
- Sharing a match is one tap: host generates a URL like `https://…/?r=ABC123`, sends it via WhatsApp/iMessage/Discord, joiner taps to join.
- No accounts, no signup, no central game server.
- Best-of-N flow: play a round, "Play again?" reuses the same connection with a fresh seed.

## Non-goals (MVP)

- More than 2 players, spectators, ranked matchmaking.
- Reconnect after a long disconnect (graceful "match abandoned" is fine).
- Mobile-data NAT guarantees — if strict-NAT users can't connect, document and revisit (TURN relay is the eventual fallback, not free).
- Anti-cheat. Both peers run the same simulation; cheating is possible but uninteresting in friend-vs-friend play.

## Approach

**Lockstep with input delay**, peer-to-peer over WebRTC.

- Sim runs at a fixed 30 Hz tick. Each tick `T` consumes a list of commands from both sides; `step(state, FIXED_DT)` then advances.
- Local commands captured on tick `T` are scheduled for tick `T + INPUT_DELAY` (≈ 3 ticks ≈ 100 ms) and immediately sent to the peer. This buffer hides RTT.
- Both peers must have inputs for tick `T` before either advances. If peer is slow, we wait and show a "Waiting for opponent…" overlay.
- Even when no input is captured, every tick sends an empty command frame as a heartbeat so the remote knows we're alive and has something to apply.
- Render runs every animation frame; sim ticks accumulate independently.

Why lockstep:

- Sim is already deterministic-friendly (no `Math.random`/`Date.now` in `src/game`, plain arrays, JSON-serializable state).
- Commands are tiny (build / mutate / noop) — bandwidth is trivial.
- No authoritative server needed.
- Matches the existing SPEC technical goal of "deterministic simulation".

## Transport

[Trystero](https://github.com/dmotz/trystero) over WebRTC. Signaling rides public BitTorrent trackers (default) with Nostr as a fallback strategy. Zero infra cost.

A `Transport` interface wraps Trystero so we can swap to PeerJS or a self-hosted signaling server later without touching game code.

## Lobby flow

1. Host opens game → "Multiplayer → Host". App generates a 6-char Crockford base32 room code from `crypto.getRandomValues` (30 bits ≈ 1B combos, collision-safe for our scale). URL becomes `?r=ABC123`. UI offers Web Share (WhatsApp/iMessage on mobile) and copy-to-clipboard.
2. Joiner opens the URL. App reads `?r=…`, jumps straight to "Joining ABC123…".
3. Both peers `joinRoom({ appId: "sporefall.v1" }, "ABC123")`. First peer event resolves connection.
4. Tiny handshake:
   - `hello { protocolVersion, clientId }` both ways
   - host → joiner: `init { seed, firstTick, opts }`
   - joiner → host: `ready`
   - both arm a short start countdown so first-tick timing is approximately simultaneous
5. Match starts.

## Rematch flow

When `state.winner` is set, both sides see "Play again? [Yes / Leave]". On both `rematch{accept:true}`:

- Host generates a new seed, broadcasts a rematch `init`.
- Both call `runner.reset(newSeed)` and clear UI.
- Same Trystero room is reused — no re-share needed.

## Side assignment & rendering

- Sim semantics stay absolute: `state.left` is the host, `state.right` is the joiner. `nextStructureId` and command application are deterministic based on absolute side.
- MVP simplification: the joiner sees the natural layout where their colony is on the right. A proper view-flip (always render "you" on the left) is a follow-up — touches a lot of `GameScene` rendering code and isn't required for playability.
- AI is disabled in MP modes. The right colony's commands come from the network instead of `SimpleAI`.

## Determinism contract

For lockstep to hold, both clients must produce bit-identical state every tick given the same seed and same per-tick command stream. The sim today is well-positioned:

- No `Math.random` / `Date.now` / `performance.now` / `new Date` in `src/game/*` (verified by grep).
- No `Map` / `Set` / `for…in` / `Object.keys` iteration in the sim — all loops are over fixed-order arrays.
- All randomness in `SimpleAI` will be routed through a seeded `mulberry32` RNG (instance already exists in `scripts/balance-sim.ts`, will move to `src/game/rng.ts`).
- `dt` becomes a fixed constant (`FIXED_DT = 1/30`) instead of the variable per-frame value used today (`scenes/GameScene.ts:621`).
- Sim only uses `+ - * / Math.min Math.max Math.floor` — no `sin`/`cos`/`exp`, which avoids the cross-engine transcendental drift trap.

A `npm run determinism-check` script will run two independent sim instances from the same seed against a scripted command log and assert `hashState(a) === hashState(b)` every tick.

In live matches, both peers exchange a state hash every 30 ticks. Two consecutive mismatches halt the match with a "out of sync" notice and one-click rematch.

## Protocol

```ts
type NetMessage =
  | { t: "hello"; protocolVersion: number; clientId: string }
  | { t: "init"; seed: number; firstTick: number; opts: {} } // host → joiner
  | { t: "ready" }                                            // joiner → host
  | { t: "input"; tick: number; cmds: Command[] }             // every tick, both ways
  | { t: "ping"; nonce: number; sentAt: number }
  | { t: "pong"; nonce: number; sentAt: number }
  | { t: "hash"; tick: number; hash: string }                 // every 30 ticks
  | { t: "rematch"; accept: boolean; seed?: number }

type Command =
  | { kind: "noop" }
  | { kind: "build"; side: Side; structure: StructureKind }
  | { kind: "mutate"; side: Side; slotIdx: number }
```

## Implementation phases

### Phase 1 — Determinism foundation (no networking)

- `src/game/rng.ts`: `mulberry32(seed)`, `hashState(state)`.
- `src/game/commands.ts`: `Command` type, `applyCommand(state, cmd)` (validates with `canBuild`/`canMutate`, dispatches).
- `src/game/ai.ts`: `SimpleAI.update(state, dt)` returns `Command | null` instead of mutating. RNG required, no `Math.random` default.
- `scripts/balance-sim.ts`: updated to apply returned commands.
- `scripts/determinism-check.ts`: two-instance harness, asserts hash equality across N ticks.
- `npm run determinism-check` script wired up.

**Acceptance:** determinism check passes 1000 ticks across two instances; existing single-player game and balance sim still behave identically.

### Phase 2 — Fixed-step sim runner

- `src/game/SimRunner.ts`: owns state + tick + accumulator + per-tick command queue. `advance(realDtMs)` consumes accumulated time at `FIXED_DT` while command frames are available.
- `scenes/GameScene.ts`: route `step` and `ai.update` through the runner; `onBuildTap`/`onUpgradeTap` submit commands instead of calling `build`/`mutate`.

**Acceptance:** single-player plays identically; sim runs at fixed 30 Hz; render stays smooth.

### Phase 3 — Transport + lobby

- `src/net/Transport.ts`: interface + `NetMessage` union.
- `src/net/TrysteroTransport.ts`: Trystero-backed implementation. Torrent strategy default, Nostr fallback.
- `src/net/room.ts`: room code generation, URL parsing, share URL builder.
- `src/net/Lobby.ts`: connection state machine + handshake.
- `index.html`: `#mp-overlay` with Host / Join / share controls (DOM, mirrors existing `#spread-btn` pattern).
- `src/main.ts`: route `?r=…` to join flow; emit start events for `sp` / `mp-host` / `mp-guest`.
- `scenes/GameScene.ts`: accept `mode` init data; defer `playing` phase until lobby resolves.

**Acceptance:** two browsers connect via room code on the same wifi and on different networks; handshake completes; channel ready.

### Phase 4 — Lockstep wiring + rematch

- `SimRunner` lockstep mode: per-tick frames sent every tick (heartbeat), advance gated on remote inputs, stall overlay after >1.5s wait.
- Initial input buffer pre-filled with empty frames so sim can start immediately.
- AI disabled in MP; right-side commands come from network.
- Periodic state hash exchange + desync halt.
- "Play again?" overlay → rematch with new seed in same room.

**Acceptance:** full game host↔guest, including rematch and graceful stall behavior.

### Phase 5 — Polish (optional)

- Latency pill in HUD.
- Quick chat/emote (gg, rematch?).
- Reconnect-on-transient-disconnect.
- Documented TURN configuration for strict NATs.
- Spectator mode (extra peers receive read-only state).

## Risks & de-risk plan

1. **Cross-browser determinism** (Chrome ↔ Safari floats). Mitigated by the lack of transcendentals in the sim. *Spike:* run Phase 1's check on both engines via a shared input log. ~½ day.
2. **Trystero reachability** on LTE / corporate / dual-NAT. *Spike:* 50-line "two browsers exchange a string" test page across (laptop+wifi, laptop+LTE phone, two ISPs). ~½ day. If (b)/(c) fails sometimes, document TURN need.
3. **30 Hz render smoothness.** Easy to fix later with render-side interpolation between two ticks; defer until visibly bad.
4. **Renderer mirroring.** MVP accepts joiner sees colony-on-the-right; proper flip is a follow-up.

Spikes (1) and (2) run in parallel before committing to Phase 2+.
