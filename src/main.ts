import Phaser from "phaser";
import { Lobby, type LobbyStatus } from "./net/Lobby";
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parseRoomFromUrl,
  roomShareUrl,
} from "./net/room";
import { TrysteroTransport } from "./net/TrysteroTransport";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";

// Render the canvas at devicePixelRatio so text and shapes stay crisp on
// high-DPI phones. The game size is in "backing-store" pixels; the canvas is
// scaled back down via CSS so the viewport still reads as innerWidth × innerHeight.
// Cap at 3 to keep fill rate reasonable on 4x panels.
const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
const gamePx = (cssPx: number): number => Math.round(cssPx * dpr);

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#1b120a",
  scale: {
    mode: Phaser.Scale.NONE,
    width: gamePx(window.innerWidth),
    height: gamePx(window.innerHeight),
  },
  scene: [BootScene, GameScene],
  render: {
    pixelArt: false,
    antialias: true,
  },
});

const fitCanvasToViewport = (): void => {
  const canvas = game.canvas;
  if (!canvas) return;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
};

game.events.once(Phaser.Core.Events.READY, fitCanvasToViewport);

const handleViewportResize = (): void => {
  game.scale.resize(gamePx(window.innerWidth), gamePx(window.innerHeight));
  fitCanvasToViewport();
};

window.addEventListener("resize", handleViewportResize);
window.addEventListener("orientationchange", handleViewportResize);

// Expose for debugging in the browser console.
(window as unknown as { game: Phaser.Game }).game = game;

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

const isFullscreen = (): boolean => {
  const d = document as FsDocument;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
};

const enterFullscreen = async (): Promise<void> => {
  const root = document.documentElement as FsElement;
  try {
    if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else if (root.webkitRequestFullscreen) {
      await root.webkitRequestFullscreen();
    }
  } catch {
    /* fullscreen denied */
  }
  const orientation = screen.orientation as
    | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
    | undefined;
  try {
    if (orientation?.lock) {
      await orientation.lock("landscape");
    }
  } catch {
    /* lock unsupported (iOS Safari) — rotate overlay handles it */
  }
};

const exitFullscreen = async (): Promise<void> => {
  const d = document as FsDocument;
  try {
    if (d.exitFullscreen) {
      await d.exitFullscreen();
    } else if (d.webkitExitFullscreen) {
      await d.webkitExitFullscreen();
    }
  } catch {
    /* ignore */
  }
};

const fsBtn = document.getElementById("fullscreen-btn");
if (fsBtn) {
  fsBtn.addEventListener("click", () => {
    if (isFullscreen()) {
      void exitFullscreen();
    } else {
      void enterFullscreen();
    }
  });
}

// Button stays visible in the menu so players can enter fullscreen+landscape
// before tapping Spread, and as a mid-match fallback when the browser couldn't
// honor the orientation lock (iOS Safari) or the user left fullscreen.
const isLandscape = (): boolean => {
  const type = screen.orientation?.type;
  if (type) return type.startsWith("landscape");
  return window.innerWidth > window.innerHeight;
};

const applyFsBtnVisibility = (): void => {
  if (!fsBtn) return;
  const fullscreenLandscape = isFullscreen() && isLandscape();
  fsBtn.classList.toggle("visible", !fullscreenLandscape);
};

document.addEventListener("fullscreenchange", applyFsBtnVisibility);
document.addEventListener("webkitfullscreenchange", applyFsBtnVisibility);
window.addEventListener("orientationchange", applyFsBtnVisibility);
screen.orientation?.addEventListener?.("change", applyFsBtnVisibility);

applyFsBtnVisibility();

// The Spread CTA is a native button rather than a Phaser GameObject so the
// fullscreen / orientation-lock request fires inside the real user gesture.
// Phaser queues pointer events until the next scene update, which puts the
// would-be fullscreen call outside the gesture and the browser rejects it.
const spreadBtn = document.getElementById("spread-btn") as HTMLButtonElement | null;
if (spreadBtn) {
  spreadBtn.addEventListener("click", () => {
    // Fullscreen + orientation lock only matters on touch devices; desktop
    // players shouldn't have their window forced fullscreen.
    if (window.matchMedia("(pointer: coarse)").matches) {
      void enterFullscreen();
    }
    window.dispatchEvent(new CustomEvent("sporefall:start"));
  });
}

// ---------- Multiplayer lobby (Phase 3) ----------
// At this phase the overlay drives the connection + handshake. Once the
// handshake reaches `ready` we surface the seed + our side; Phase 4 picks
// that up and kicks off the lockstep match.

const mpBtn = document.getElementById("mp-btn") as HTMLButtonElement | null;
const mpOverlay = document.getElementById("mp-overlay");
const mpHome = document.getElementById("mp-home");
const mpJoin = document.getElementById("mp-join");
const mpShare = document.getElementById("mp-share");
const mpShareCode = document.getElementById("mp-share-code");
const mpStatus = document.getElementById("mp-status");
const mpError = document.getElementById("mp-error");
const mpHostBtn = document.getElementById("mp-host-btn") as HTMLButtonElement | null;
const mpJoinBtn = document.getElementById("mp-join-btn") as HTMLButtonElement | null;
const mpCloseBtn = document.getElementById("mp-close-btn") as HTMLButtonElement | null;
const mpJoinBackBtn = document.getElementById("mp-join-back-btn") as HTMLButtonElement | null;
const mpJoinGoBtn = document.getElementById("mp-join-go-btn") as HTMLButtonElement | null;
const mpCodeInput = document.getElementById("mp-code-input") as HTMLInputElement | null;
const mpShareCopyBtn = document.getElementById("mp-share-copy-btn") as HTMLButtonElement | null;
const mpShareNativeBtn = document.getElementById("mp-share-native-btn") as HTMLButtonElement | null;
const mpCancelBtn = document.getElementById("mp-cancel-btn") as HTMLButtonElement | null;

let activeLobby: Lobby | null = null;
let currentShareUrl = "";

const showMpBtn = (visible: boolean): void => {
  mpBtn?.classList.toggle("visible", visible);
};

const setMpError = (text: string): void => {
  if (mpError) mpError.textContent = text;
};

const setMpStatus = (text: string): void => {
  if (mpStatus) mpStatus.textContent = text;
};

type MpView = "home" | "join" | "share";

const setMpView = (view: MpView): void => {
  if (mpHome) mpHome.style.display = view === "home" ? "" : "none";
  if (mpJoin) mpJoin.style.display = view === "join" ? "" : "none";
  if (mpShare) mpShare.classList.toggle("visible", view === "share");
};

const openMpOverlay = (view: MpView = "home"): void => {
  mpOverlay?.classList.add("visible");
  setMpView(view);
  setMpError("");
  setMpStatus("");
};

const closeMpOverlay = (): void => {
  mpOverlay?.classList.remove("visible");
  activeLobby?.close();
  activeLobby = null;
  setMpError("");
  setMpStatus("");
  setMpView("home");
};

const handleLobbyStatus = (status: LobbyStatus): void => {
  switch (status.kind) {
    case "hosting":
      setMpStatus("Waiting for your friend to join…");
      setMpError("");
      return;
    case "joining":
      setMpStatus(`Connecting to room ${status.code}…`);
      setMpError("");
      return;
    case "handshaking":
      setMpStatus("Peer found — syncing…");
      return;
    case "ready": {
      setMpStatus(`Connected! Starting match…`);
      setMpError("");
      const transport = activeLobby?.transportRef();
      // Clear the active lobby reference WITHOUT calling close() — we hand
      // the transport off to the game scene which now owns it.
      activeLobby = null;
      mpOverlay?.classList.remove("visible");
      showMpBtn(false);
      if (transport) {
        window.dispatchEvent(
          new CustomEvent("sporefall:start-mp", {
            detail: {
              transport,
              seed: status.seed,
              ourSide: status.ourSide,
              firstTick: status.firstTick,
            },
          }),
        );
      }
      return;
    }
    case "error":
      setMpError(status.message);
      setMpStatus("");
      activeLobby?.close();
      activeLobby = null;
      return;
    case "idle":
      return;
  }
};

const startHost = (): void => {
  if (activeLobby) return;
  const code = generateRoomCode();
  currentShareUrl = roomShareUrl(code);
  if (mpShareCode) mpShareCode.textContent = code;
  setMpView("share");
  setMpError("");
  setMpStatus("Opening room…");
  if (mpShareNativeBtn) {
    const canShare = typeof navigator.share === "function";
    mpShareNativeBtn.style.display = canShare ? "" : "none";
  }
  try {
    activeLobby = new Lobby({
      role: "host",
      code,
      shareUrl: currentShareUrl,
      makeTransport: (c) => new TrysteroTransport(c),
      onStatus: handleLobbyStatus,
    });
  } catch (err) {
    setMpError(err instanceof Error ? err.message : String(err));
  }
};

const startJoin = (rawCode: string): void => {
  if (activeLobby) return;
  const code = normalizeRoomCode(rawCode);
  if (!isValidRoomCode(code)) {
    setMpError("That doesn't look like a valid 6-character code.");
    return;
  }
  openMpOverlay("share");
  if (mpShareCode) mpShareCode.textContent = code;
  // Hide the copy controls on the guest side — they have no URL to share.
  const copyRow = document.getElementById("mp-share-copy-btn");
  if (copyRow) copyRow.style.display = "none";
  if (mpShareNativeBtn) mpShareNativeBtn.style.display = "none";
  setMpStatus(`Connecting to room ${code}…`);
  try {
    activeLobby = new Lobby({
      role: "guest",
      code,
      makeTransport: (c) => new TrysteroTransport(c),
      onStatus: handleLobbyStatus,
    });
  } catch (err) {
    setMpError(err instanceof Error ? err.message : String(err));
  }
};

mpBtn?.addEventListener("click", () => openMpOverlay("home"));
mpCloseBtn?.addEventListener("click", closeMpOverlay);
mpCancelBtn?.addEventListener("click", closeMpOverlay);
mpHostBtn?.addEventListener("click", startHost);
mpJoinBtn?.addEventListener("click", () => {
  setMpView("join");
  setMpError("");
  mpCodeInput?.focus();
});
mpJoinBackBtn?.addEventListener("click", () => setMpView("home"));
mpJoinGoBtn?.addEventListener("click", () => {
  if (mpCodeInput) startJoin(mpCodeInput.value);
});
mpCodeInput?.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && mpCodeInput) startJoin(mpCodeInput.value);
});

mpShareCopyBtn?.addEventListener("click", async () => {
  if (!currentShareUrl) return;
  try {
    await navigator.clipboard.writeText(currentShareUrl);
    mpShareCopyBtn.textContent = "Copied ✓";
    setTimeout(() => {
      if (mpShareCopyBtn) mpShareCopyBtn.textContent = "Copy share link";
    }, 1500);
  } catch {
    setMpError("Couldn't access the clipboard — long-press the code to copy.");
  }
});

mpShareNativeBtn?.addEventListener("click", async () => {
  if (!currentShareUrl) return;
  try {
    await navigator.share({
      title: "Sporefall — Join my match",
      text: "Tap to join my Sporefall match:",
      url: currentShareUrl,
    });
  } catch {
    /* user cancelled */
  }
});

// Show the MP entry point by default. (Later phases can hide it mid-match.)
showMpBtn(true);

// If the URL carries a room code, jump straight into the join flow.
const urlRoom = parseRoomFromUrl();
if (urlRoom) {
  startJoin(urlRoom);
}
