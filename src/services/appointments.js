const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const tableName = process.env.APPOINTMENTS_TABLE;
const slotsTableName = process.env.APPOINTMENT_SLOTS_TABLE;
const archiveBucket = process.env.APPOINTMENT_ARCHIVE_BUCKET;
const ACTIVE_APPOINTMENT_STATUSES = new Set(["BOOKED", "RESCHEDULED"]);

function nowIso() {
  return new Date().toISOString();
}

async function archiveSnapshot(appointmentId, action, payload) {
  if (!archiveBucket) return;

  const key = `${appointmentId}/${Date.now()}-${action}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: archiveBucket,
      Key: key,
      ContentType: "application/json",
      Body: JSON.stringify(payload)
    })
  );
}

function buildHistoryEvent(action, changedBy, metadata) {
  return {
    eventId: randomUUID(),
    action,
    changedBy,
    metadata: metadata || {},
    timestamp: nowIso()
  };
}

function isFutureActiveAppointment(appointment, nowEpochMs) {
  if (!appointment) return false;
  if (!ACTIVE_APPOINTMENT_STATUSES.has(appointment.status)) return false;
  const scheduledEpochMs = Date.parse(appointment.scheduledAt || "");
  if (!Number.isFinite(scheduledEpochMs)) return false;
  return scheduledEpochMs > nowEpochMs;
}

async function findFutureActiveAppointment(contactPhone) {
  const appointments = await listAppointments(contactPhone);
  const nowEpochMs = Date.now();
  return appointments.find((appointment) => isFutureActiveAppointment(appointment, nowEpochMs)) || null;
}

async function createAppointment({
  userId,
  firstName,
  lastName,
  contactPhone,
  scheduledAt,
  scheduledEndAt,
  slotStart,
  slotEnd,
  notes,
  source = "phone"
}) {
  const existingFutureAppointment = await findFutureActiveAppointment(contactPhone);
  if (existingFutureAppointment) {
    const error = new Error("A future appointment already exists for this phone number.");
    error.name = "FutureAppointmentExistsError";
    error.appointmentId = existingFutureAppointment.appointmentId;
    throw error;
  }

  const appointmentId = randomUUID();
  const timestamp = nowIso();
  const historyEvent = buildHistoryEvent("booked", userId, { scheduledAt, source, firstName, lastName });

  const appointment = {
    appointmentId,
    userId,
    firstName,
    lastName,
    contactPhone,
    scheduledAt,
    scheduledEndAt,
    slotStart,
    slotEnd,
    notes: notes || "",
    source,
    status: "BOOKED",
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [historyEvent]
  };

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: slotsTableName,
              Item: {
                slotStart,
                slotEnd,
                appointmentId,
                contactPhone,
                status: "BOOKED",
                createdAt: timestamp
              },
              ConditionExpression: "attribute_not_exists(slotStart)"
            }
          },
          {
            Put: {
              TableName: tableName,
              Item: appointment
            }
          }
        ]
      })
    );
  } catch (error) {
    const conflictError = new Error("The requested 15-minute slot is already booked.");
    conflictError.name = "SlotUnavailableError";
    conflictError.slotStart = slotStart;
    if (error.name === "TransactionCanceledException") {
      throw conflictError;
    }
    throw error;
  }

  await archiveSnapshot(appointmentId, "booked", appointment);
  return appointment;
}

async function getAppointment(appointmentId) {
  const result = await dynamo.send(
    new GetCommand({
      TableName: tableName,
      Key: { appointmentId }
    })
  );
  return result.Item || null;
}

async function listAppointments(contactPhone) {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "contactPhoneIndex",
      KeyConditionExpression: "contactPhone = :contactPhone",
      ExpressionAttributeValues: {
        ":contactPhone": contactPhone
      }
    })
  );
  return result.Items || [];
}

async function cancelAppointment({ appointmentId, contactPhone, reason }) {
  const current = await getAppointment(appointmentId);
  if (!current || current.contactPhone !== contactPhone) {
    throw new Error("Appointment not found or user mismatch.");
  }

  const historyEvent = buildHistoryEvent("cancelled", contactPhone, { reason: reason || "" });
  const updatedAt = nowIso();

  const nowEpochMs = Date.now();
  const transactItems = [];
  if (isFutureActiveAppointment(current, nowEpochMs) && current.slotStart) {
    transactItems.push({
      Delete: {
        TableName: slotsTableName,
        Key: { slotStart: current.slotStart },
        ConditionExpression: "appointmentId = :appointmentId",
        ExpressionAttributeValues: {
          ":appointmentId": appointmentId
        }
      }
    });
  }

  transactItems.push({
    Update: {
      TableName: tableName,
      Key: { appointmentId },
      ConditionExpression: "attribute_exists(appointmentId) AND contactPhone = :contactPhone",
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt, #history = list_append(if_not_exists(#history, :empty), :entry)",
      ExpressionAttributeNames: {
        "#status": "status",
        "#history": "history"
      },
      ExpressionAttributeValues: {
        ":contactPhone": contactPhone,
        ":status": "CANCELLED",
        ":updatedAt": updatedAt,
        ":entry": [historyEvent],
        ":empty": []
      }
    }
  });

  await dynamo.send(
    new TransactWriteCommand({
      TransactItems: transactItems
    })
  );

  const updated = await getAppointment(appointmentId);
  await archiveSnapshot(appointmentId, "cancelled", updated);
  return updated;
}

async function rescheduleAppointment({ appointmentId, contactPhone, scheduledAt, scheduledEndAt, slotStart, slotEnd, reason }) {
  const current = await getAppointment(appointmentId);
  if (!current || current.contactPhone !== contactPhone) {
    throw new Error("Appointment not found or user mismatch.");
  }

  if (current.slotStart === slotStart) {
    const noChangeError = new Error("New slot matches existing appointment slot.");
    noChangeError.name = "NoChangeSlotError";
    throw noChangeError;
  }

  const historyEvent = buildHistoryEvent("rescheduled", contactPhone, { scheduledAt, reason: reason || "" });
  const updatedAt = nowIso();

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: slotsTableName,
              Item: {
                slotStart,
                slotEnd,
                appointmentId,
                contactPhone,
                status: "RESCHEDULED",
                updatedAt
              },
              ConditionExpression: "attribute_not_exists(slotStart)"
            }
          },
          {
            Delete: {
              TableName: slotsTableName,
              Key: { slotStart: current.slotStart },
              ConditionExpression: "appointmentId = :appointmentId",
              ExpressionAttributeValues: {
                ":appointmentId": appointmentId
              }
            }
          },
          {
            Update: {
              TableName: tableName,
              Key: { appointmentId },
              ConditionExpression: "attribute_exists(appointmentId) AND contactPhone = :contactPhone",
              UpdateExpression:
                "SET scheduledAt = :scheduledAt, scheduledEndAt = :scheduledEndAt, slotStart = :slotStart, slotEnd = :slotEnd, #status = :status, updatedAt = :updatedAt, #history = list_append(if_not_exists(#history, :empty), :entry)",
              ExpressionAttributeNames: {
                "#status": "status",
                "#history": "history"
              },
              ExpressionAttributeValues: {
                ":contactPhone": contactPhone,
                ":scheduledAt": scheduledAt,
                ":scheduledEndAt": scheduledEndAt,
                ":slotStart": slotStart,
                ":slotEnd": slotEnd,
                ":status": "RESCHEDULED",
                ":updatedAt": updatedAt,
                ":entry": [historyEvent],
                ":empty": []
              }
            }
          }
        ]
      })
    );
  } catch (error) {
    const conflictError = new Error("The requested 15-minute slot is already booked.");
    conflictError.name = "SlotUnavailableError";
    conflictError.slotStart = slotStart;
    if (error.name === "TransactionCanceledException") {
      throw conflictError;
    }
    throw error;
  }

  const updated = await getAppointment(appointmentId);
  await archiveSnapshot(appointmentId, "rescheduled", updated);
  return updated;
}

module.exports = {
  createAppointment,
  getAppointment,
  listAppointments,
  cancelAppointment,
  rescheduleAppointment
};
