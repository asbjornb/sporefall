import { joinRoom, selfId } from "trystero";
import type { NetMessage, Transport } from "./Transport";

const APP_ID = "sporefall.v1";

/**
 * Trystero-backed transport. Uses Trystero's default strategy (Nostr relays)
 * for signaling; once peers are paired the actual game traffic runs over
 * plain WebRTC data channels. Zero infrastructure cost.
 *
 * Under the hood this sends a single `msg` action carrying the full tagged
 * NetMessage — simpler than one action per variant, and still well under the
 * chunk limit for our tiny payloads.
 */
export class TrysteroTransport implements Transport {
  private readonly room: ReturnType<typeof joinRoom>;
  private readonly sendMsg: (payload: NetMessage) => void;
  private messageCbs: ((msg: NetMessage) => void)[] = [];
  private connectCbs: ((peerId: string) => void)[] = [];
  private disconnectCbs: ((peerId: string) => void)[] = [];

  readonly selfId: string;

  constructor(roomCode: string) {
    this.room = joinRoom({ appId: APP_ID }, roomCode);
    this.selfId = selfId;

    const [sender, receiver] = this.room.makeAction<NetMessage>("msg");
    this.sendMsg = sender as (payload: NetMessage) => void;
    receiver((payload) => {
      const msg = payload as NetMessage;
      for (const cb of this.messageCbs) cb(msg);
    });

    this.room.onPeerJoin((peerId: string) => {
      for (const cb of this.connectCbs) cb(peerId);
    });
    this.room.onPeerLeave((peerId: string) => {
      for (const cb of this.disconnectCbs) cb(peerId);
    });
  }

  send(msg: NetMessage): void {
    this.sendMsg(msg);
  }

  onMessage(cb: (msg: NetMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onPeerConnect(cb: (peerId: string) => void): void {
    this.connectCbs.push(cb);
  }

  onPeerDisconnect(cb: (peerId: string) => void): void {
    this.disconnectCbs.push(cb);
  }

  close(): void {
    this.room.leave();
  }
}
