const {
  createAppointment,
  getAppointment,
  listAppointments,
  cancelAppointment,
  rescheduleAppointment
} = require("./services/appointments");
const { issueOtp, verifyOtp } = require("./services/phoneAuth");
const { resolveScheduleWindow } = require("./utils/scheduling");
const RESTRICTED_INTENTS = new Set([
  "CancelAppointmentIntent",
  "RescheduleAppointmentIntent",
  "ViewAppointmentDetailsIntent",
  "ViewAppointmentHistoryIntent"
]);

function getLexSlotValue(slots, key) {
  const slot = slots?.[key];
  return slot?.value?.interpretedValue || slot?.value?.originalValue || null;
}

function buildLexResponse(intentName, sessionAttributes, message, fulfilled = true) {
  return {
    sessionState: {
      dialogAction: { type: "Close" },
      intent: {
        name: intentName,
        state: fulfilled ? "Fulfilled" : "Failed"
      },
      sessionAttributes
    },
    messages: [{ contentType: "PlainText", content: message }]
  };
}

function isPhoneVerified(sessionAttributes) {
  return String(sessionAttributes?.phoneVerified || "false").toLowerCase() === "true";
}

function normalizeIdentityFromLex(event) {
  const sessionAttributes = event.sessionState?.sessionAttributes || {};
  const userId = sessionAttributes.userId || sessionAttributes.phoneNumber || "phone-caller";
  return {
    userId,
    contactPhone: sessionAttributes.phoneNumber || "",
    sessionAttributes
  };
}

function normalizeIdentityFromConnect(event) {
  const attrs = event.Details?.ContactData?.Attributes || {};
  const customerEndpoint = event.Details?.ContactData?.CustomerEndpoint?.Address || "";
  const userId = attrs.userId || attrs.phoneNumber || customerEndpoint || "phone-caller";
  return {
    userId,
    contactPhone: attrs.phoneNumber || customerEndpoint,
    attrs
  };
}

async function handleBook({ userId, firstName, lastName, contactPhone, scheduledAt, scheduledDay, scheduledTime, notes }) {
  if (!firstName || !lastName) throw new Error("firstName and lastName are required to book an appointment.");
  const scheduleWindow = resolveScheduleWindow({ scheduledAt, scheduledDay, scheduledTime });
  const appointment = await createAppointment({
    userId,
    firstName,
    lastName,
    contactPhone,
    scheduledAt: scheduleWindow.scheduledAtUtc,
    scheduledEndAt: scheduleWindow.scheduledEndAtUtc,
    slotStart: scheduleWindow.slotStartUtc,
    slotEnd: scheduleWindow.slotEndUtc,
    notes,
    source: "phone"
  });
  return { appointment, message: `Booked. Your appointment ID is ${appointment.appointmentId}.` };
}

async function handleCancel({ userId, appointmentId, reason }) {
  if (!appointmentId) throw new Error("appointmentId is required to cancel.");
  const appointment = await cancelAppointment({ contactPhone: userId, appointmentId, reason });
  return { appointment, message: `Appointment ${appointment.appointmentId} was cancelled.` };
}

async function handleReschedule({ userId, appointmentId, scheduledAt, scheduledDay, scheduledTime, reason }) {
  if (!appointmentId) throw new Error("appointmentId is required to reschedule.");
  const scheduleWindow = resolveScheduleWindow({ scheduledAt, scheduledDay, scheduledTime });
  const appointment = await rescheduleAppointment({
    contactPhone: userId,
    appointmentId,
    scheduledAt: scheduleWindow.scheduledAtUtc,
    scheduledEndAt: scheduleWindow.scheduledEndAtUtc,
    slotStart: scheduleWindow.slotStartUtc,
    slotEnd: scheduleWindow.slotEndUtc,
    reason
  });
  return { appointment, message: `Appointment ${appointment.appointmentId} was rescheduled to ${appointment.scheduledAt}.` };
}

async function handleList({ userId }) {
  const items = await listAppointments(userId);
  if (items.length === 0) return { items, message: "You have no appointments." };
  return { items, message: `You have ${items.length} appointment(s).` };
}

async function handleDetails({ userId, appointmentId }) {
  if (!appointmentId) throw new Error("appointmentId is required to view details.");
  const appointment = await getAppointment(appointmentId);
  if (!appointment || appointment.contactPhone !== userId) throw new Error("Appointment not found.");
  return { appointment, message: `Appointment ${appointment.appointmentId} is ${appointment.status} at ${appointment.scheduledAt}.` };
}

async function handleHistory({ userId, appointmentId }) {
  if (!appointmentId) throw new Error("appointmentId is required to view history.");
  const appointment = await getAppointment(appointmentId);
  if (!appointment || appointment.contactPhone !== userId) throw new Error("Appointment not found.");
  const events = appointment.history || [];
  return { events, message: `Appointment ${appointmentId} has ${events.length} history event(s).` };
}

exports.handler = async (event) => {
  try {
    if (event?.sessionState?.intent?.name) {
      const intentName = event.sessionState.intent.name;
      const slots = event.sessionState.intent.slots || {};
      const identity = normalizeIdentityFromLex(event);
      const phoneNumber = identity.contactPhone || identity.userId;

      if (intentName === "VerifyOtpIntent") {
        const otpCode = getLexSlotValue(slots, "OtpCode");
        if (!phoneNumber) {
          return buildLexResponse(intentName, identity.sessionAttributes, "I could not determine your phone number for verification.", false);
        }
        const verified = await verifyOtp(phoneNumber, otpCode);
        if (!verified) {
          return buildLexResponse(intentName, identity.sessionAttributes, "That code is invalid or expired. Please ask me to send a new verification code.", false);
        }
        return buildLexResponse(
          intentName,
          {
            ...identity.sessionAttributes,
            phoneVerified: "true",
            phoneNumber
          },
          "Verification successful. You can continue with your request.",
          true
        );
      }

      if (RESTRICTED_INTENTS.has(intentName) && !isPhoneVerified(identity.sessionAttributes)) {
        if (!phoneNumber) {
          return buildLexResponse(intentName, identity.sessionAttributes, "I could not determine your phone number for verification.", false);
        }
        await issueOtp(phoneNumber);
        return buildLexResponse(
          intentName,
          {
            ...identity.sessionAttributes,
            phoneNumber
          },
          "For security, I sent a verification code by text. Say verify code and provide the 6-digit code.",
          false
        );
      }

      let result;
      if (intentName === "BookAppointmentIntent") {
        result = await handleBook({
          userId: identity.userId,
          firstName: getLexSlotValue(slots, "FirstName") || identity.sessionAttributes.firstName,
          lastName: getLexSlotValue(slots, "LastName") || identity.sessionAttributes.lastName,
          contactPhone: identity.contactPhone,
          scheduledAt: getLexSlotValue(slots, "ScheduledAt"),
          scheduledDay: getLexSlotValue(slots, "ScheduledDay"),
          scheduledTime: getLexSlotValue(slots, "ScheduledTime"),
          notes: getLexSlotValue(slots, "Notes")
        });
      } else if (intentName === "CancelAppointmentIntent") {
        result = await handleCancel({
          userId: identity.userId,
          appointmentId: getLexSlotValue(slots, "AppointmentId"),
          reason: getLexSlotValue(slots, "Reason")
        });
      } else if (intentName === "RescheduleAppointmentIntent") {
        result = await handleReschedule({
          userId: identity.userId,
          appointmentId: getLexSlotValue(slots, "AppointmentId"),
          scheduledAt: getLexSlotValue(slots, "ScheduledAt"),
          scheduledDay: getLexSlotValue(slots, "ScheduledDay"),
          scheduledTime: getLexSlotValue(slots, "ScheduledTime"),
          reason: getLexSlotValue(slots, "Reason")
        });
      } else if (intentName === "ViewAppointmentsIntent") {
        result = await handleList({ userId: identity.userId });
      } else if (intentName === "ViewAppointmentDetailsIntent") {
        result = await handleDetails({
          userId: identity.userId,
          appointmentId: getLexSlotValue(slots, "AppointmentId")
        });
      } else if (intentName === "ViewAppointmentHistoryIntent") {
        result = await handleHistory({
          userId: identity.userId,
          appointmentId: getLexSlotValue(slots, "AppointmentId")
        });
      } else {
        return buildLexResponse(intentName, identity.sessionAttributes, `Unsupported intent: ${intentName}`, false);
      }

      const updatedSessionAttributes = {
        ...identity.sessionAttributes,
        userId: identity.userId
      };
      if (result.appointment?.firstName) {
        updatedSessionAttributes.firstName = result.appointment.firstName;
      }
      if (result.appointment?.lastName) {
        updatedSessionAttributes.lastName = result.appointment.lastName;
      }
      if (result.appointment?.appointmentId) {
        updatedSessionAttributes.lastAppointmentId = result.appointment.appointmentId;
      }

      return buildLexResponse(intentName, updatedSessionAttributes, result.message, true);
    }

    if (event?.Details?.ContactData) {
      const identity = normalizeIdentityFromConnect(event);
      const params = event.Details?.Parameters || {};
      const action = (params.Action || "").toLowerCase();
      const phoneNumber = identity.contactPhone || identity.userId;
      const restrictedActions = new Set(["cancel", "reschedule", "details", "history"]);

      if (action === "verifyotp") {
        const verified = await verifyOtp(phoneNumber, params.OtpCode);
        return {
          success: verified,
          verificationRequired: !verified,
          message: verified
            ? "Verification successful. Continue your request."
            : "Invalid or expired code. Request a new verification code."
        };
      }

      if (restrictedActions.has(action) && String(params.Verified || "false").toLowerCase() !== "true") {
        await issueOtp(phoneNumber);
        return {
          success: false,
          verificationRequired: true,
          message: "Verification required. OTP sent by text.",
          nextAction: "verifyotp"
        };
      }

      let result;
      if (action === "book") {
        result = await handleBook({
          userId: identity.userId,
          firstName: params.FirstName || identity.attrs.firstName,
          lastName: params.LastName || identity.attrs.lastName,
          contactPhone: identity.contactPhone,
          scheduledAt: params.ScheduledAt,
          scheduledDay: params.ScheduledDay,
          scheduledTime: params.ScheduledTime,
          notes: params.Notes
        });
      } else if (action === "cancel") {
        result = await handleCancel({
          userId: identity.userId,
          appointmentId: params.AppointmentId,
          reason: params.Reason
        });
      } else if (action === "reschedule") {
        result = await handleReschedule({
          userId: identity.userId,
          appointmentId: params.AppointmentId,
          scheduledAt: params.ScheduledAt,
          scheduledDay: params.ScheduledDay,
          scheduledTime: params.ScheduledTime,
          reason: params.Reason
        });
      } else if (action === "list") {
        result = await handleList({ userId: identity.userId });
      } else if (action === "details") {
        result = await handleDetails({ userId: identity.userId, appointmentId: params.AppointmentId });
      } else if (action === "history") {
        result = await handleHistory({ userId: identity.userId, appointmentId: params.AppointmentId });
      } else {
        return { success: false, message: "Unsupported action for Amazon Connect Lambda block." };
      }

      return { success: true, ...result };
    }

    return { success: false, message: "Unsupported voice event payload." };
  } catch (error) {
    console.error("Voice handler error", error);
    if (event?.sessionState?.intent?.name) {
      return buildLexResponse(
        event.sessionState.intent.name,
        event.sessionState.sessionAttributes || {},
        error.message || "Voice request failed.",
        false
      );
    }
    return { success: false, message: error.message || "Voice request failed." };
  }
};
