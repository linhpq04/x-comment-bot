/**
 * Active time slots — English only
 * All times in GMT+7
 *
 *   US Peak    19:00–23:00 GMT+7  → 07:00–11:00 EST  🔥 BEST
 */

export type Lang = "en";

export interface TimeSlot {
  id: string;
  label: string;
  lang: Lang;
  startHour: number; // GMT+7
  endHour: number; // GMT+7 (exclusive)
  priority: number;
}

export const TIME_SLOTS: TimeSlot[] = [
  {
    id: "en_us_morning",
    label: "🇺🇸 US Morning (2-5)",
    lang: "en",
    startHour: 2,
    endHour: 5,
    priority: 3,
  },
];

/** Returns current hour in GMT+7 */
export function getHourGmt7(): number {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const gmt7 = new Date(utcMs + 7 * 3600_000);
  return gmt7.getHours();
}

/** Returns currently active time slots */
export function getActiveSlots(): TimeSlot[] {
  if (process.env.DISABLE_TIMESLOT === "true") return TIME_SLOTS;
  const h = getHourGmt7();
  return TIME_SLOTS.filter((s) => h >= s.startHour && h < s.endHour);
}

/**
 * Returns monitor state + appropriate interval for current time.
 * - Outside active hours → { active: false }
 * - Inside active hours → { active: true, intervalMs: 5 minutes }
 */
export function getMonitorState():
  | { active: false }
  | { active: true; intervalMs: number } {
  if (process.env.DISABLE_TIMESLOT === "true") {
    const ms = parseInt(process.env.MONITOR_INTERVAL_ACTIVE ?? "300") * 1000;
    return { active: true, intervalMs: ms };
  }
  if (getActiveSlots().length === 0) return { active: false };
  const sec = parseInt(process.env.MONITOR_INTERVAL_ACTIVE ?? "300");
  return { active: true, intervalMs: sec * 1000 };
}

/** Check if a slot is currently active */
export function isSlotActive(slotId: string): boolean {
  return getActiveSlots().some((s) => s.id === slotId);
}

/** Active slot names for logging */
export function getActiveSlotNames(): string {
  const active = getActiveSlots();
  if (active.length === 0) return "(outside active hours — monitor off)";
  return active.map((s) => s.label).join(", ");
}

/** Time slot table for Telegram */
export function formatTimeSlotsTable(): string {
  return [
    "⏰ *Active Time Slots (GMT+7)*\n",
    "🔥 *Active Slot:*",
    "  🇺🇸 02:00–05:00 → US Peak (07–11 EST)",
    "",
    "⚡ Monitor interval: 5 minutes during active hours",
    "💤 Outside active hours: fully paused (saves API quota)",
  ].join("\n");
}
