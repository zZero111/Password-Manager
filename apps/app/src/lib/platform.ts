import { isTauri } from "@tauri-apps/api/core";

export const inTauri = isTauri();

/** Best-effort friendly device name for the devices list. */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Mac OS X/i.test(ua)
        ? "macOS"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Unknown OS";
  return `${inTauri ? "Keyhold app" : "Browser"} on ${os}`;
}
