import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#1b120a",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1280,
    height: 720,
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
