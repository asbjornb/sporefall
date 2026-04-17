import Phaser from "phaser";
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
    void enterFullscreen();
    window.dispatchEvent(new CustomEvent("sporefall:start"));
  });
}
