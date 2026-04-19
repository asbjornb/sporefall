import { PROTOCOL_VERSION, type NetMessage, type Transport } from "./Transport";

export type Side = "left" | "right";

export type LobbyStatus =
  | { kind: "idle" }
  | { kind: "hosting"; code: string; shareUrl: string }
  | { kind: "joining"; code: string }
  | { kind: "handshaking"; code: string; peerId: string }
  | { kind: "ready"; code: string; peerId: string; seed: number; ourSide: Side; firstTick: number }
  | { kind: "error"; message: string };

export interface LobbyConfig {
  role: "host" | "guest";
  code: string;
  shareUrl?: string;
  makeTransport: (code: string) => Transport;
  onStatus: (status: LobbyStatus) => void;
}

/**
 * Drives the connection + handshake from "just joined the room" through to
 * "both peers agreed on seed and start tick". Once `ready` is reached, the
 * caller takes over the transport for gameplay (heartbeat input frames).
 *
 * Protocol:
 *   host → guest:  hello
 *   guest → host:  hello
 *   host → guest:  init { seed, firstTick }
 *   guest → host:  ready
 *   both:          enter `ready` status
 *
 * Host is always "left", guest is always "right" — absolute sides in the sim.
 * UI mirroring (showing "you" on the left regardless of side) is the
 * renderer's concern, not this layer's.
 */
export class Lobby {
  private readonly transport: Transport;
  private readonly cfg: LobbyConfig;
  private peerId: string | null = null;
  private heardHello = false;
  private sentHello = false;
  private closed = false;

  constructor(cfg: LobbyConfig) {
    this.cfg = cfg;
    this.transport = cfg.makeTransport(cfg.code);

    this.transport.onPeerConnect((peerId) => this.handlePeerConnect(peerId));
    this.transport.onPeerDisconnect(() => this.handlePeerDisconnect());
    this.transport.onMessage((msg) => this.handleMessage(msg));

    this.setStatus(
      cfg.role === "host"
        ? { kind: "hosting", code: cfg.code, shareUrl: cfg.shareUrl ?? "" }
        : { kind: "joining", code: cfg.code },
    );
  }

  /** Returns the underlying transport once the lobby reaches `ready`. */
  transportRef(): Transport {
    return this.transport;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  private setStatus(status: LobbyStatus): void {
    if (this.closed && status.kind !== "error") return;
    this.cfg.onStatus(status);
  }

  private handlePeerConnect(peerId: string): void {
    // Only talk to the first peer that joins — a third connection means
    // somebody else guessed the code. Ignore it.
    if (this.peerId) return;
    this.peerId = peerId;
    this.setStatus({
      kind: "handshaking",
      code: this.cfg.code,
      peerId,
    });
    this.sendHello();
  }

  private handlePeerDisconnect(): void {
    if (this.closed) return;
    this.setStatus({
      kind: "error",
      message: "Peer disconnected before the match started.",
    });
  }

  private sendHello(): void {
    if (this.sentHello) return;
    this.sentHello = true;
    this.transport.send({
      t: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.cfg.role,
    });
  }

  private handleMessage(msg: NetMessage): void {
    switch (msg.t) {
      case "hello":
        this.handleHello(msg);
        return;
      case "init":
        this.handleInit(msg);
        return;
      case "ready":
        this.handleReady();
        return;
      default:
        // Anything else arriving during handshake is out-of-phase; ignore.
        return;
    }
  }

  private handleHello(msg: NetMessage & { t: "hello" }): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.setStatus({
        kind: "error",
        message: `Version mismatch (local ${PROTOCOL_VERSION}, remote ${msg.protocolVersion}). Both players need to refresh.`,
      });
      this.close();
      return;
    }
    if (!this.heardHello) {
      this.heardHello = true;
      // Send ours back if we haven't already (unlikely race).
      this.sendHello();
      if (this.cfg.role === "host") {
        const seed = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
        this.transport.send({ t: "init", seed, firstTick: 0 });
        this.pendingInit = { seed, firstTick: 0 };
      }
    }
  }

  private pendingInit: { seed: number; firstTick: number } | null = null;

  private handleInit(msg: NetMessage & { t: "init" }): void {
    if (this.cfg.role !== "guest") return; // host generated the seed itself
    this.transport.send({ t: "ready" });
    this.enterReady({ seed: msg.seed, firstTick: msg.firstTick });
  }

  private handleReady(): void {
    if (this.cfg.role !== "host") return;
    if (!this.pendingInit) return;
    this.enterReady(this.pendingInit);
  }

  private enterReady(init: { seed: number; firstTick: number }): void {
    if (!this.peerId) return;
    this.setStatus({
      kind: "ready",
      code: this.cfg.code,
      peerId: this.peerId,
      seed: init.seed,
      ourSide: this.cfg.role === "host" ? "left" : "right",
      firstTick: init.firstTick,
    });
  }
}
