// Persisted player settings. A leaf module — it imports nothing, so the menu shell, the
// audio engine and the game scene can all read the toggles without depending on each other.

/**
 * The Settings toggles, stored as "1"/"0". menu.ts writes them, audio.ts and main.ts read
 * them back through getSetting(), so the key strings are spelled out in this module only.
 */
export type SettingKey = "hearth-muted" | "hearth-shownames";

const SETTING_DEFAULTS: Record<SettingKey, boolean> = {
  "hearth-muted": false,
  "hearth-shownames": true,
};

export function getSetting(key: SettingKey): boolean {
  const v = localStorage.getItem(key);
  return v === null ? SETTING_DEFAULTS[key] : v === "1";
}

export function setSetting(key: SettingKey, on: boolean): void {
  localStorage.setItem(key, on ? "1" : "0");
}
