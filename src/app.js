const express = require("express");
const {
  createAppointment,
  getAppointment,
  listAppointments,
  cancelAppointment,
  rescheduleAppointment
} = require("./services/appointments");
const { getServiceConfig } = require("./config");
const { resolveScheduleWindow } = require("./utils/scheduling");

const app = express();
app.use(express.json());

function getIdentity(req) {
  const event = req.apiGateway?.event || {};
  const jwtClaims = event.requestContext?.authorizer?.jwt?.claims || {};

  return {
    userId: jwtClaims.sub || req.header("x-user-id"),
    phoneNumber: jwtClaims.phone_number || req.header("x-user-phone")
  };
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/config", (_req, res) => {
  res.status(200).json(getServiceConfig());
});

app.post("/appointments", async (req, res) => {
  const { userId, phoneNumber } = getIdentity(req);
  const { firstName, lastName, scheduledAt, scheduledDay, scheduledTime, notes, source } = req.body || {};

  if (!phoneNumber) {
    return res.status(401).json({ message: "Unauthorized: phone number is required." });
  }

  if (!firstName || !lastName) {
    return res.status(400).json({ message: "firstName and lastName are required." });
  }
  let scheduleWindow;
  try {
    scheduleWindow = resolveScheduleWindow({ scheduledAt, scheduledDay, scheduledTime });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  let appointment;
  try {
    appointment = await createAppointment({
      userId: userId || phoneNumber,
      firstName,
      lastName,
      contactPhone: phoneNumber || "",
      scheduledAt: scheduleWindow.scheduledAtUtc,
      scheduledEndAt: scheduleWindow.scheduledEndAtUtc,
      slotStart: scheduleWindow.slotStartUtc,
      slotEnd: scheduleWindow.slotEndUtc,
      notes,
      source: source || "phone"
    });
  } catch (error) {
    if (error.name === "FutureAppointmentExistsError") {
      return res.status(409).json({
        message: "You already have a future appointment. Cancel or reschedule it before booking a new one.",
        appointmentId: error.appointmentId
      });
    }
    if (error.name === "SlotUnavailableError") {
      return res.status(409).json({
        message: "This 15-minute window is already booked. Please choose another slot.",
        slotStart: error.slotStart
      });
    }
    throw error;
  }

  return res.status(201).json(appointment);
});

app.get("/appointments", async (req, res) => {
  const { phoneNumber } = getIdentity(req);
  if (!phoneNumber) {
    return res.status(401).json({ message: "Unauthorized: phone number is required." });
  }

  const appointments = await listAppointments(phoneNumber);
  return res.status(200).json({ items: appointments });
});

app.get("/appointments/:appointmentId", async (req, res) => {
  const { phoneNumber } = getIdentity(req);
  if (!phoneNumber) {
    return res.status(401).json({ message: "Unauthorized: phone number is required." });
  }

  const appointment = await getAppointment(req.params.appointmentId);
  if (!appointment || appointment.contactPhone !== phoneNumber) {
    return res.status(404).json({ message: "Appointment not found." });
  }

  return res.status(200).json(appointment);
});

app.get("/appointments/:appointmentId/history", async (req, res) => {
  const { phoneNumber } = getIdentity(req);
  if (!phoneNumber) {
    return res.status(401).json({ message: "Unauthorized: phone number is required." });
  }

  const appointment = await getAppointment(req.params.appointmentId);
  if (!appointment || appointment.contactPhone !== phoneNumber) {
    return res.status(404).json({ message: "Appointment not found." });
  }

  return res.status(200).json({ appointmentId: appointment.appointmentId, history: appointment.history || [] });
});

app.post("/appointments/:appointmentId/cancel", async (req, res) => {
  const { phoneNumber } = getIdentity(req);
  if (!phoneNumber) {
    return res.status(401).json({ message: "Unauthorized: phone number is required." });
  }

  try {
    const result = await cancelAppointment({
      appointmentId: req.params.appointmentId,
      contactPhone: phoneNumber,
      reason: req.body?.reason
    });
    return res.status(200).json(result);
  } catch (_error) {
    return res.status(404).json({ message: "Appointment not found or user mismatch." });
  }
});

app.put("/appointments/:appointmentId/reschedule", async (req, res) => {
  const { phoneNumber } = getIdentity(req);
  if (!phoneNumber) {
    return res.status(401).json({ message: "Unauthorized: phone number is required." });
  }

  let scheduleWindow;
  try {
    scheduleWindow = resolveScheduleWindow({
      scheduledAt: req.body?.scheduledAt,
      scheduledDay: req.body?.scheduledDay,
      scheduledTime: req.body?.scheduledTime
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  try {
    const result = await rescheduleAppointment({
      appointmentId: req.params.appointmentId,
      contactPhone: phoneNumber,
      scheduledAt: scheduleWindow.scheduledAtUtc,
      scheduledEndAt: scheduleWindow.scheduledEndAtUtc,
      slotStart: scheduleWindow.slotStartUtc,
      slotEnd: scheduleWindow.slotEndUtc,
      reason: req.body.reason
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error.name === "SlotUnavailableError") {
      return res.status(409).json({
        message: "This 15-minute window is already booked. Please choose another slot.",
        slotStart: error.slotStart
      });
    }
    return res.status(404).json({ message: "Appointment not found or user mismatch." });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: "Unexpected server error." });
});

module.exports = app;
