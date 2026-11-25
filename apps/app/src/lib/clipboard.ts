import { getSettings } from "./settings";
import { inTauri } from "./platform";

let clearTimer: ReturnType<typeof setTimeout> | undefined;

async function write(text: string) {
  if (inTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}

async function read(): Promise<string | null> {
  try {
    if (inTauri) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    }
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** Copy, then wipe the clipboard after the configured delay if it still holds our value. */
export async function copySecret(text: string): Promise<void> {
  await write(text);
  clearTimeout(clearTimer);
  const seconds = getSettings().clipboardClearSeconds;
  if (seconds > 0) {
    clearTimer = setTimeout(async () => {
      const now = await read();
      // If we can't read the clipboard (browser permissions), clear anyway.
      if (now === null || now === text) await write("").catch(() => {});
    }, seconds * 1000);
  }
}
