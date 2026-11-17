// config/rally.ts
// Rally settings. Change the numbers here; nothing else needs to know them.
export const RALLY = {
  /** The most villages one rally can have, the host included (the host picks a smaller number if it wants). */
  maxParticipantsLimit: 100,
  /** The most troops (all units counted one by one) one rally can carry; the host picks a smaller cap if it wants. */
  maxTroopsLimit: 1000000,

  /** Defaults the panel starts with. */
  defaultParticipants: 5,
  defaultTroops: 100000,
  defaultTimerMin: 10,
};
