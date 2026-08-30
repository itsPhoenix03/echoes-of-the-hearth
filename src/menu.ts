// Front-end menu shell. Owns all menu DOM/state; main.ts never reaches into this.
import { getSetting, setSetting } from "./settings.ts";

export interface JoinOpts {
  name: string;
  room: string;
}

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function sanitizeName(raw: string): string {
  return raw.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 18);
}

function genRoomCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return s;
}

function isValidRoomCode(code: string): boolean {
  if (code.length !== 6) return false;
  for (const c of code) if (!ROOM_ALPHABET.includes(c)) return false;
  return true;
}

function getStoredName(): string {
  return localStorage.getItem("hearth-name") || "";
}

type ScreenName = "home" | "create" | "join" | "profile" | "settings";

const SCREEN_NAMES: ScreenName[] = [
  "home",
  "create",
  "join",
  "profile",
  "settings",
];

/**
 * Re-show the title screen on Home, with the username refreshed from storage.
 * Used by the in-game Quit button (via the "hearth:quit" event) after the game
 * has torn itself down.
 */
export function showMenu(): void {
  const menu = document.getElementById("menu");
  if (!menu) return;
  const nameEl = document.getElementById("menu-home-name");
  if (nameEl) nameEl.textContent = getStoredName() || "no name set";
  // the in-game M key can have flipped mute while the menu was hidden
  const soundEl = document.getElementById("menu-settings-sound") as HTMLInputElement | null;
  if (soundEl) soundEl.checked = !getSetting("hearth-muted");
  SCREEN_NAMES.forEach((k) => {
    document.getElementById("menu-" + k)?.classList.toggle("active", k === "home");
  });
  menu.dataset.screen = "home";
  menu.style.display = "flex";
}

export function initMenu(onJoin: (opts: JoinOpts) => void): void {
  const menu = document.getElementById("menu");
  if (!menu) return;

  const screens: Record<ScreenName, HTMLElement> = {
    home: document.getElementById("menu-home")!,
    create: document.getElementById("menu-create")!,
    join: document.getElementById("menu-join")!,
    profile: document.getElementById("menu-profile")!,
    settings: document.getElementById("menu-settings")!,
  };

  const homeName = document.getElementById("menu-home-name")!;
  const createCodeEl = document.getElementById("menu-create-code")!;
  const createCopyBtn = document.getElementById(
    "menu-create-copy",
  ) as HTMLButtonElement;
  const createStartBtn = document.getElementById(
    "menu-create-start",
  ) as HTMLButtonElement;

  const joinInput = document.getElementById(
    "menu-join-input",
  ) as HTMLInputElement;
  const joinError = document.getElementById("menu-join-error")!;
  const joinBtn = document.getElementById(
    "menu-join-submit",
  ) as HTMLButtonElement;
  const joinSoloBtn = document.getElementById(
    "menu-join-solo",
  ) as HTMLButtonElement;

  const profileInput = document.getElementById(
    "menu-profile-input",
  ) as HTMLInputElement;
  const profilePreview = document.getElementById("menu-profile-preview")!;
  const profileError = document.getElementById("menu-profile-error")!;
  const profileSaveBtn = document.getElementById(
    "menu-profile-save",
  ) as HTMLButtonElement;

  const soundToggle = document.getElementById(
    "menu-settings-sound",
  ) as HTMLInputElement;
  const namesToggle = document.getElementById(
    "menu-settings-names",
  ) as HTMLInputElement;

  let createCode = localStorage.getItem("hearth-room") || "";
  let pendingAfterName: (() => void) | null = null;

  function showScreen(name: ScreenName) {
    (Object.keys(screens) as ScreenName[]).forEach((k) => {
      screens[k].classList.toggle("active", k === name);
    });
    // Drives the backdrop dimming and the corner controls in CSS.
    menu!.dataset.screen = name;
  }

  function refreshHome() {
    const n = getStoredName();
    homeName.textContent = n || "no name set";
  }

  function openProfile(message: string) {
    const msgEl = document.getElementById("menu-profile-message")!;
    if (message) {
      msgEl.textContent = message;
      msgEl.hidden = false;
    } else {
      msgEl.hidden = true;
    }
    const current = getStoredName();
    profileInput.value = current || "Keeper";
    updateProfilePreview();
    showScreen("profile");
  }

  function ensureNameThen(action: () => void) {
    if (getStoredName().length >= 2) {
      action();
      return;
    }
    pendingAfterName = action;
    openProfile("Choose a username before joining the world.");
  }

  function finishJoin(room: string) {
    menu!.style.display = "none";
    onJoin({ name: getStoredName(), room });
  }

  function updateProfilePreview() {
    const clean = sanitizeName(profileInput.value);
    profilePreview.textContent = clean || "(too short)";
  }

  // Home navigation
  document
    .getElementById("menu-create-btn")!
    .addEventListener("click", () => {
      if (!createCode) {
        createCode = genRoomCode();
        localStorage.setItem("hearth-room", createCode);
      }
      createCodeEl.textContent = createCode;
      showScreen("create");
    });
  document.getElementById("menu-join-btn")!.addEventListener("click", () => {
    joinInput.value = localStorage.getItem("hearth-room") || "";
    joinError.setAttribute("hidden", "");
    showScreen("join");
  });
  document
    .getElementById("menu-profile-btn")!
    .addEventListener("click", () => openProfile(""));
  document
    .getElementById("menu-settings-btn")!
    .addEventListener("click", () => showScreen("settings"));

  menu.querySelectorAll<HTMLButtonElement>("[data-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingAfterName = null;
      refreshHome();
      showScreen("home");
    });
  });

  // Create room screen
  createCopyBtn.addEventListener("click", () => {
    navigator.clipboard?.writeText(createCode).catch(() => {});
    const prev = createCopyBtn.textContent;
    createCopyBtn.textContent = "Copied!";
    setTimeout(() => (createCopyBtn.textContent = prev), 1200);
  });
  createStartBtn.addEventListener("click", () => {
    ensureNameThen(() => finishJoin(createCode));
  });

  // Join room screen
  joinInput.addEventListener("input", () => {
    const up = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    joinInput.value = up.slice(0, 6);
    joinError.setAttribute("hidden", "");
  });
  joinBtn.addEventListener("click", () => {
    const code = joinInput.value.trim();
    if (!isValidRoomCode(code)) {
      joinError.textContent =
        "Enter a 6-character code (letters A-Z and digits 2-9, no O/0/I/1).";
      joinError.removeAttribute("hidden");
      return;
    }
    ensureNameThen(() => {
      localStorage.setItem("hearth-room", code);
      finishJoin(code);
    });
  });
  joinSoloBtn.addEventListener("click", () => {
    ensureNameThen(() => finishJoin(""));
  });

  // Profile screen
  profileInput.addEventListener("input", updateProfilePreview);
  profileSaveBtn.addEventListener("click", () => {
    const clean = sanitizeName(profileInput.value);
    if (clean.length < 2) {
      profileError.textContent = "Name must be at least 2 characters.";
      profileError.removeAttribute("hidden");
      return;
    }
    profileError.setAttribute("hidden", "");
    localStorage.setItem("hearth-name", clean);
    document.getElementById("menu-profile-message")!.hidden = true;
    const next = pendingAfterName;
    pendingAfterName = null;
    if (next) {
      next();
    } else {
      refreshHome();
      showScreen("home");
    }
  });

  // Settings screen
  // The sound toggle is worded positively ("Sound on"), the stored key negatively.
  soundToggle.checked = !getSetting("hearth-muted");
  namesToggle.checked = getSetting("hearth-shownames");
  soundToggle.addEventListener("change", () => {
    setSetting("hearth-muted", !soundToggle.checked);
  });
  namesToggle.addEventListener("change", () => {
    setSetting("hearth-shownames", namesToggle.checked);
  });

  // The in-game Quit button dispatches this; registered here so it is always live.
  window.addEventListener("hearth:quit", () => showMenu());

  refreshHome();
  showScreen("home");
  menu.style.display = "flex";
}
