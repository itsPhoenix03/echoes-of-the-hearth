// Network configuration + the control-plane join handshake.
//
// Slice 1 splits the old single Node server in two:
//   * the Node CONTROL PLANE (:8090) authenticates the player and issues a short-lived
//     signed ticket plus the URL of the game server that owns the world;
//   * the Go GAME SERVER (:8082) is authoritative for the world itself. Its first frame
//     must be `{t:'auth', ticket}` — see docs/10_GO_WIRE_PROTOCOL.md §1.
//
// Every environment-dependent URL lives here. Nothing else in src/ may hardcode a port.

/** Base URL of the Node control plane. Override with VITE_CONTROL_URL at build/dev time. */
export const CONTROL_URL: string =
  (import.meta as any).env?.VITE_CONTROL_URL ||
  `${location.protocol}//${location.hostname}:8090`;

/** Legacy single-server (:8081) fallback. See LEGACY below. */
export const LEGACY_WS_PORT: string =
  (import.meta as any).env?.VITE_LEGACY_PORT || "8081";

/**
 * Legacy mode: talk to the old all-in-one Node server on :8081, which sends no chunks and
 * expects the client to generate terrain itself. Off by default; enable with `?legacy=1`
 * in the URL or VITE_LEGACY=1. Kept so the pre-migration server stays playable while the
 * Go runtime is still gaining features.
 */
export const LEGACY: boolean =
  new URLSearchParams(location.search).get("legacy") === "1" ||
  (import.meta as any).env?.VITE_LEGACY === "1";

export interface JoinTicket {
  ticket: string;
  ws: string;
  worldId: string;
  name: string;
}

/** The persistent identity token. Never cleared — it is the save key. */
export function identityToken(): string {
  let tok = localStorage.getItem("hearth-tok");
  if (!tok) {
    tok = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("hearth-tok", tok);
  }
  return tok;
}

/**
 * POST /api/join on the control plane. Resolves with the ticket + the game-server WS URL.
 * Rejects with a player-readable Error on any transport or protocol failure.
 */
export async function requestJoin(name: string): Promise<JoinTicket> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_URL}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, tok: identityToken() }),
    });
  } catch {
    throw new Error(
      `Could not reach the login server at ${CONTROL_URL}. Is it running? (npm run control)`,
    );
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* fall through to the status check */
  }
  if (!res.ok)
    throw new Error(
      `Login refused (${res.status}): ${body?.error || "unknown error"}`,
    );
  if (!body?.ticket || !body?.ws)
    throw new Error("Login server returned an incomplete ticket.");
  return body as JoinTicket;
}
