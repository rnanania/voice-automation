const { DateTime } = require("luxon");

const NEW_YORK_TIMEZONE = "America/New_York";
const SLOT_MINUTES = 15;

function parseDateInNewYork(scheduledDay) {
  if (!scheduledDay) return null;

  const normalizedDay = String(scheduledDay).trim().toLowerCase();
  const now = DateTime.now().setZone(NEW_YORK_TIMEZONE);

  if (normalizedDay === "today") return now.startOf("day");
  if (normalizedDay === "tomorrow") return now.plus({ days: 1 }).startOf("day");

  const isoDate = DateTime.fromISO(String(scheduledDay), { zone: NEW_YORK_TIMEZONE });
  if (isoDate.isValid) return isoDate.startOf("day");
  return null;
}

function parseTimeInNewYork(scheduledTime) {
  if (!scheduledTime) return null;

  const timeText = String(scheduledTime).trim().toLowerCase();
  const formats = ["H:mm", "HH:mm", "h:mm a", "h a"];

  for (const format of formats) {
    const parsed = DateTime.fromFormat(timeText, format, { zone: NEW_YORK_TIMEZONE, locale: "en-US" });
    if (parsed.isValid) {
      return { hour: parsed.hour, minute: parsed.minute };
    }
  }

  const isoTime = DateTime.fromISO(`1970-01-01T${scheduledTime}`, { zone: NEW_YORK_TIMEZONE });
  if (isoTime.isValid) {
    return { hour: isoTime.hour, minute: isoTime.minute };
  }

  return null;
}

function normalizeAndValidateSlot(dateTimeInNewYork) {
  const normalized = dateTimeInNewYork.set({ second: 0, millisecond: 0 });
  if (normalized.minute % SLOT_MINUTES !== 0) {
    throw new Error("Appointments must start at a 15-minute boundary (e.g. 12:00, 12:15, 12:30, 12:45).");
  }
  return normalized;
}

function buildSlotWindow(dateTimeInNewYork) {
  const slotStart = normalizeAndValidateSlot(dateTimeInNewYork);
  const slotEnd = slotStart.plus({ minutes: SLOT_MINUTES });
  return {
    scheduledAtUtc: slotStart.toUTC().toISO(),
    scheduledEndAtUtc: slotEnd.toUTC().toISO(),
    slotStartUtc: slotStart.toUTC().toISO({ suppressMilliseconds: true }),
    slotEndUtc: slotEnd.toUTC().toISO({ suppressMilliseconds: true })
  };
}

function resolveScheduleWindow({ scheduledAt, scheduledDay, scheduledTime }) {
  if (scheduledAt) {
    const parsed = DateTime.fromISO(String(scheduledAt), { setZone: true });
    if (!parsed.isValid) {
      throw new Error("scheduledAt is invalid. Provide ISO format or day/time.");
    }
    return buildSlotWindow(parsed.setZone(NEW_YORK_TIMEZONE));
  }

  const day = parseDateInNewYork(scheduledDay);
  const time = parseTimeInNewYork(scheduledTime);
  if (!day || !time) {
    throw new Error("Provide scheduledAt or both scheduledDay and scheduledTime.");
  }
  return buildSlotWindow(day.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 }));
}

module.exports = {
  NEW_YORK_TIMEZONE,
  SLOT_MINUTES,
  resolveScheduleWindow
};
