const { DateTime } = require("luxon");

const NEW_YORK_TIMEZONE = "America/New_York";

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

function resolveScheduledAt({ scheduledAt, scheduledDay, scheduledTime }) {
  if (scheduledAt) {
    const parsed = DateTime.fromISO(String(scheduledAt), { setZone: true });
    if (!parsed.isValid) {
      throw new Error("scheduledAt is invalid. Provide ISO format or day/time.");
    }
    return parsed.setZone(NEW_YORK_TIMEZONE).toUTC().toISO();
  }

  const day = parseDateInNewYork(scheduledDay);
  const time = parseTimeInNewYork(scheduledTime);
  if (!day || !time) {
    throw new Error("Provide scheduledAt or both scheduledDay and scheduledTime.");
  }

  return day
    .set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO();
}

module.exports = {
  NEW_YORK_TIMEZONE,
  resolveScheduledAt
};
