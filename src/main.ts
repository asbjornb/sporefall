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

// On touch devices, try to enter fullscreen and lock landscape on first tap.
// Browsers only allow this from a user gesture, so we attach a one-shot listener.
if (window.matchMedia("(pointer: coarse)").matches) {
  const tryLockLandscape = async (): Promise<void> => {
    const root = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    try {
      if (root.requestFullscreen) {
        await root.requestFullscreen();
      } else if (root.webkitRequestFullscreen) {
        await root.webkitRequestFullscreen();
      }
    } catch {
      /* fullscreen denied — continue anyway */
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
  window.addEventListener("pointerdown", tryLockLandscape, { once: true });
}
