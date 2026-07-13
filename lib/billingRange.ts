// Date-range math for the Billing page — everything is bucketed by IST
// calendar day (Asia/Kolkata), same convention as the Analytics page, since
// this is a single-timezone Indian business and staff think in IST dates,
// not UTC. Shared by the Billing page and its CSV export route so both
// always agree on exactly which rows belong to "Today"/"This Month"/etc.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Converts an IST calendar date (y-m-d) into the UTC Date instant that is
// midnight IST on that day — IST is a fixed UTC+5:30 offset, no DST.
export function istMidnightUtc(y: number, m: number, d: number): Date {
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(utcMidnight - 5.5 * 60 * 60 * 1000);
}

export function istDayKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // "YYYY-MM-DD"
}

function addDaysToKey(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export type BillingRange = {
  label: string;
  dayKeys: string[]; // IST "YYYY-MM-DD", ascending
  from: Date; // UTC bound, inclusive
  to: Date; // UTC bound, exclusive
};

const MAX_RANGE_DAYS = 92; // ~3 months — keeps the table/chart/CSV bounded even on a bad custom range

const VALID_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function resolveDailyRange(params: { range?: string; from?: string; to?: string }): BillingRange {
  const todayKey = istDayKey(new Date());
  const range = params.range || "today";

  let startKey = todayKey;
  let endKey = todayKey;
  let label = "Today";

  if (range === "yesterday") {
    startKey = addDaysToKey(todayKey, -1);
    endKey = startKey;
    label = "Yesterday";
  } else if (range === "week") {
    startKey = addDaysToKey(todayKey, -6);
    endKey = todayKey;
    label = "Last 7 Days";
  } else if (range === "month") {
    const [y, m] = todayKey.split("-");
    startKey = `${y}-${m}-01`;
    endKey = todayKey;
    label = "This Month";
  } else if (range === "custom" && params.from && params.to && VALID_DAY.test(params.from) && VALID_DAY.test(params.to)) {
    startKey = params.from;
    endKey = params.to;
    if (startKey > endKey) [startKey, endKey] = [endKey, startKey];
    label = `${startKey} to ${endKey}`;
  }

  const dayKeys: string[] = [];
  let cursor = startKey;
  let guard = 0;
  while (cursor <= endKey && guard < MAX_RANGE_DAYS) {
    dayKeys.push(cursor);
    cursor = addDaysToKey(cursor, 1);
    guard++;
  }
  if (dayKeys.length === 0) dayKeys.push(todayKey); // guards against a malformed custom range

  const [sy, sm, sd] = dayKeys[0].split("-").map(Number);
  const lastKey = dayKeys[dayKeys.length - 1];
  const [ey, em, ed] = lastKey.split("-").map(Number);
  const from = istMidnightUtc(sy, sm, sd);
  const to = istMidnightUtc(ey, em, ed + 1); // exclusive — Date.UTC rolls the day over correctly even past month-end

  return { label, dayKeys, from, to };
}

// Ascending "YYYY-MM" keys, oldest to newest, current month last.
export function lastNMonthKeys(n: number): string[] {
  const todayKey = istDayKey(new Date());
  const [ty, tm] = todayKey.split("-").map(Number);
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    let y = ty;
    let m = tm - i;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    keys.push(`${y}-${pad(m)}`);
  }
  return keys;
}

export function monthRangeBounds(monthKeys: string[]): { from: Date; to: Date } {
  const [fy, fm] = monthKeys[0].split("-").map(Number);
  const [ly, lm] = monthKeys[monthKeys.length - 1].split("-").map(Number);
  const from = istMidnightUtc(fy, fm, 1);
  const nextY = lm === 12 ? ly + 1 : ly;
  const nextM = lm === 12 ? 1 : lm + 1;
  const to = istMidnightUtc(nextY, nextM, 1);
  return { from, to };
}
