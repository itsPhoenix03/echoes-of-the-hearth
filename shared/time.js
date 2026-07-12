// Single source of truth for the day/night cycle — imported by server AND client.
// See docs/SMALL_IMPROVEMENTS_AND_FIXES.md (Improvement 1). Recommended profile: 15-min day.
export const TICK_MS = 200;
export const DAY_LENGTH_SEC = 900;
export const NIGHT_START = 0.72;   // time-of-day fraction when night begins
export const NIGHT_END = 0.08;     // fraction when night ends
export const isNightTime = (t) => t > NIGHT_START || t < NIGHT_END;
