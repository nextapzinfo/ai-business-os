// Business timezone for Banglar Doi (India, IST). Server functions on Vercel run
// in UTC by default, so any date rendered with a plain toLocaleString()/
// toLocaleDateString() ends up several hours off — these helpers pin the
// timezone explicitly so dashboard timestamps always match local time.
const BUSINESS_TIMEZONE = "Asia/Kolkata";

export function formatDateTime(date: Date): string {
  return date.toLocaleString("en-IN", {
    timeZone: BUSINESS_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { timeZone: BUSINESS_TIMEZONE });
}
