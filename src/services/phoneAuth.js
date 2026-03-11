const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { PublishCommand, SNSClient } = require("@aws-sdk/client-sns");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

const phoneAuthTable = process.env.PHONE_AUTH_TABLE;
const otpTtlSeconds = Number(process.env.OTP_TTL_SECONDS || 300);

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

async function issueOtp(phoneNumber) {
  if (!phoneNumber) {
    throw new Error("phone number is required for OTP.");
  }

  const code = generateOtpCode();
  const expiresAt = nowEpoch() + otpTtlSeconds;

  await dynamo.send(
    new PutCommand({
      TableName: phoneAuthTable,
      Item: {
        phoneNumber,
        code,
        expiresAt,
        ttl: expiresAt
      }
    })
  );

  await sns.send(
    new PublishCommand({
      PhoneNumber: phoneNumber,
      Message: `Your appointment verification code is ${code}. It expires in ${Math.floor(otpTtlSeconds / 60)} minutes.`
    })
  );
}

async function verifyOtp(phoneNumber, otpCode) {
  if (!phoneNumber || !otpCode) return false;

  const result = await dynamo.send(
    new GetCommand({
      TableName: phoneAuthTable,
      Key: { phoneNumber }
    })
  );
  const record = result.Item;
  if (!record) return false;
  if (record.expiresAt < nowEpoch()) return false;
  if (String(record.code) !== String(otpCode)) return false;

  await dynamo.send(
    new DeleteCommand({
      TableName: phoneAuthTable,
      Key: { phoneNumber }
    })
  );
  return true;
}

module.exports = {
  issueOtp,
  verifyOtp
};
