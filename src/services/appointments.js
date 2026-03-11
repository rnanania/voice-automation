const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const tableName = process.env.APPOINTMENTS_TABLE;
const archiveBucket = process.env.APPOINTMENT_ARCHIVE_BUCKET;

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

async function createAppointment({ userId, firstName, lastName, contactPhone, scheduledAt, notes, source = "phone" }) {
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
    notes: notes || "",
    source,
    status: "BOOKED",
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [historyEvent]
  };

  await dynamo.send(
    new PutCommand({
      TableName: tableName,
      Item: appointment
    })
  );
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
  const historyEvent = buildHistoryEvent("cancelled", contactPhone, { reason: reason || "" });
  const updatedAt = nowIso();

  const result = await dynamo.send(
    new UpdateCommand({
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
      },
      ReturnValues: "ALL_NEW"
    })
  );

  await archiveSnapshot(appointmentId, "cancelled", result.Attributes);
  return result.Attributes;
}

async function rescheduleAppointment({ appointmentId, contactPhone, scheduledAt, reason }) {
  const historyEvent = buildHistoryEvent("rescheduled", contactPhone, { scheduledAt, reason: reason || "" });
  const updatedAt = nowIso();

  const result = await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { appointmentId },
      ConditionExpression: "attribute_exists(appointmentId) AND contactPhone = :contactPhone",
      UpdateExpression:
        "SET scheduledAt = :scheduledAt, #status = :status, updatedAt = :updatedAt, #history = list_append(if_not_exists(#history, :empty), :entry)",
      ExpressionAttributeNames: {
        "#status": "status",
        "#history": "history"
      },
      ExpressionAttributeValues: {
        ":contactPhone": contactPhone,
        ":scheduledAt": scheduledAt,
        ":status": "RESCHEDULED",
        ":updatedAt": updatedAt,
        ":entry": [historyEvent],
        ":empty": []
      },
      ReturnValues: "ALL_NEW"
    })
  );

  await archiveSnapshot(appointmentId, "rescheduled", result.Attributes);
  return result.Attributes;
}

module.exports = {
  createAppointment,
  getAppointment,
  listAppointments,
  cancelAppointment,
  rescheduleAppointment
};
