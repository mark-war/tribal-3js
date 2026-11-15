// config/rally.ts
// Rally settings. Change the numbers here; nothing else needs to know them.
export const RALLY = {
  /** The most villages one rally can have, the host included (the host picks a smaller number if it wants). */
  maxParticipantsLimit: 6,
  /** The most troops (all units counted one by one) one rally can carry; the host picks a smaller cap if it wants. */
  maxTroopsLimit: 10000,
  /** Timers the host can choose, in GAME minutes: the combined army leaves when the timer ends. */
  timersMin: [5, 10, 30, 60],
  /** Defaults the panel starts with. */
  defaultParticipants: 4,
  defaultTroops: 5000,
  defaultTimerMin: 10,
};
