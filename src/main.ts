import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#1b120a",
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  scene: [BootScene, GameScene],
  render: {
    pixelArt: false,
    antialias: true,
  },
});

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

// Button is hidden during the pre-game menu (the Spread CTA handles the
// fullscreen+landscape transition itself) and once the player is actually in
// fullscreen landscape. It reappears mid-match as a fallback when the browser
// couldn't honor the orientation lock (iOS Safari) or the user left fullscreen.
type Phase = "menu" | "playing";
let phase: Phase = "menu";

const isLandscape = (): boolean => {
  const type = screen.orientation?.type;
  if (type) return type.startsWith("landscape");
  return window.innerWidth > window.innerHeight;
};

const applyFsBtnVisibility = (): void => {
  if (!fsBtn) return;
  const inGame = phase === "playing";
  const fullscreenLandscape = isFullscreen() && isLandscape();
  fsBtn.classList.toggle("visible", inGame && !fullscreenLandscape);
};

window.addEventListener("sporefall:phase", (e) => {
  const next = (e as CustomEvent<Phase>).detail;
  const wasMenu = phase === "menu";
  phase = next;
  // Spread tap: try fullscreen+landscape on the way into the match. The browser
  // requires this to happen inside the originating user gesture, but the scene
  // dispatches synchronously from the pointer handler so we're still in scope.
  if (wasMenu && next === "playing") {
    void enterFullscreen().finally(applyFsBtnVisibility);
  }
  applyFsBtnVisibility();
});

document.addEventListener("fullscreenchange", applyFsBtnVisibility);
document.addEventListener("webkitfullscreenchange", applyFsBtnVisibility);
window.addEventListener("orientationchange", applyFsBtnVisibility);
screen.orientation?.addEventListener?.("change", applyFsBtnVisibility);

applyFsBtnVisibility();
