import type { Command } from "../game/commands";

export const PROTOCOL_VERSION = 1;

/**
 * All messages exchanged between peers. Discriminated by `t`. Kept small and
 * flat so it serializes cheaply over Trystero's JSON channel.
 */
export type NetMessage =
  | { t: "hello"; protocolVersion: number; clientId: string }
  | { t: "init"; seed: number; firstTick: number }
  | { t: "ready" }
  | { t: "input"; tick: number; cmds: Command[] }
  | { t: "ping"; nonce: number; sentAt: number }
  | { t: "pong"; nonce: number; sentAt: number }
  | { t: "hash"; tick: number; hash: string }
  | { t: "rematch"; accept: boolean; seed?: number };

/**
 * Thin abstraction over the underlying P2P layer so we can swap Trystero for
 * another signaling/transport without touching game code. In real life there's
 * always exactly one remote peer — the lobby enforces that by joining a
 * room-code space that only the two players know.
 */
export interface Transport {
  send(msg: NetMessage): void;
  onMessage(cb: (msg: NetMessage) => void): void;
  onPeerConnect(cb: (peerId: string) => void): void;
  onPeerDisconnect(cb: (peerId: string) => void): void;
  close(): void;
}
