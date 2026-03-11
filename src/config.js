function getServiceConfig() {
  return {
    timezone: process.env.SERVICE_TIMEZONE || "UTC",
    language: process.env.SERVICE_LANGUAGE || "en-US",
    currency: process.env.SERVICE_CURRENCY || "USD",
    calendarScheduleGroupName: process.env.CALENDAR_SCHEDULE_GROUP_NAME || "",
    notificationPhoneNumber: process.env.NOTIFICATION_PHONE_NUMBER || ""
  };
}

module.exports = {
  getServiceConfig
};
