import type { ToolDefinition } from "@/lib/llm";
import {
  salesReport,
  targetProgress,
  setTarget,
  comparePeriods,
  eventPerformance,
  suggestEventStock,
  istToday,
  addDays,
  type SalesGroup,
} from "@/lib/biz-analyst";

// Business Analyst tools for the owner's own WhatsApp assistant
// (lib/owner-assistant.ts). Every number comes from lib/biz-analyst.ts —
// the model only picks the tool + dates and explains the result.

const dateProp = (what: string) => ({ type: "string", description: `${what} as YYYY-MM-DD (India date). Today is given in the system prompt.` });

export const BIZ_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_sales_report",
      description:
        "Banglar Doi's real sales between two dates (shops, events/stalls from Banglar Doi OS, plus banglardoi.com website orders), grouped by location, product, day, vendor or channel. Includes goods cost, rough gross profit, cash short and days whose closing is not done. ALWAYS call this for any question about sales, best/worst products, which shop or event sold more, or daily trend — never answer sales numbers from memory.",
      parameters: {
        type: "object",
        properties: {
          from: dateProp("Start date"),
          to: dateProp("End date (inclusive)"),
          group_by: { type: "string", enum: ["location", "product", "day", "vendor", "channel"] },
          location_contains: { type: "string", description: "Optional: only locations whose name contains this text, e.g. 'Patuli' or 'Trade Fair'." },
          limit: { type: "integer", description: "How many rows (default 15)." },
        },
        required: ["from", "to", "group_by"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_periods",
      description: "Compare sales of a date range with the same-length period just before it (e.g. this week vs last week), grouped. Use for 'better or worse than before', growth, drop.",
      parameters: {
        type: "object",
        properties: { from: dateProp("Start date"), to: dateProp("End date"), group_by: { type: "string", enum: ["location", "product", "channel", "vendor"] } },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_target_progress",
      description: "This month's (or a given month's) sales so far vs the owner's monthly target: achieved, %, remaining, sale needed per day.",
      parameters: { type: "object", properties: { month: { type: "string", description: "YYYY-MM; default current month" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "set_sales_target",
      description: "Save the owner's monthly sales target. ONLY when the owner clearly states a target amount for a month (e.g. 'December target 5 lakh'). Confirm month and amount back.",
      parameters: {
        type: "object",
        properties: { month: { type: "string", description: "YYYY-MM" }, amount: { type: "number", description: "Rupees, e.g. 500000 for 5 lakh" } },
        required: ["month", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_event_performance",
      description: "All events/stalls (or those whose name contains a text) with total sales, selling days, sale per day, goods cost, expenses, rough profit and cash short — best first. Use to compare events or judge whether an event is worth doing again.",
      parameters: { type: "object", properties: { name_contains: { type: "string" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_event_stock",
      description: "Suggest how many of each product to take to an upcoming event: average sold per day at past events (optionally only past events whose name contains a text, e.g. 'Trade Fair') x planned days + 10% buffer, with wastage per day.",
      parameters: {
        type: "object",
        properties: { planned_days: { type: "integer" }, similar_event_name: { type: "string" } },
        required: ["planned_days"],
      },
    },
  },
];

const BIZ_TOOL_NAMES = new Set(BIZ_TOOLS.map((t) => t.function.name));

export function isBizTool(name: string): boolean {
  return BIZ_TOOL_NAMES.has(name);
}

const okDate = (v: unknown, fallback: string) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback);

export async function executeBizTool(organizationId: string, name: string, args: Record<string, any>): Promise<string> {
  const today = istToday();
  const yesterday = addDays(today, -1);
  try {
    switch (name) {
      case "get_sales_report": {
        const from = okDate(args.from, yesterday);
        const to = okDate(args.to, from);
        const group = (["location", "product", "day", "vendor", "channel"].includes(args.group_by) ? args.group_by : "location") as SalesGroup;
        return JSON.stringify(await salesReport(organizationId, from, to, group, args.location_contains || undefined, Number(args.limit) > 0 ? Number(args.limit) : 15));
      }
      case "compare_periods":
        return JSON.stringify(await comparePeriods(organizationId, okDate(args.from, yesterday), okDate(args.to, yesterday), args.group_by || "location"));
      case "get_target_progress":
        return JSON.stringify(await targetProgress(organizationId, /^\d{4}-\d{2}$/.test(args.month || "") ? args.month : undefined));
      case "set_sales_target": {
        const month = /^\d{4}-\d{2}$/.test(args.month || "") ? args.month : today.slice(0, 7);
        const amount = Number(args.amount);
        if (!(amount > 0)) return "Not saved: amount missing.";
        await setTarget(organizationId, month, amount);
        return `Saved target ${month} = ₹${Math.round(amount).toLocaleString("en-IN")}`;
      }
      case "get_event_performance":
        return JSON.stringify((await eventPerformance(organizationId, args.name_contains || undefined)).slice(0, 25));
      case "suggest_event_stock":
        return JSON.stringify(await suggestEventStock(organizationId, Math.max(1, Number(args.planned_days) || 1), args.similar_event_name || undefined));
    }
  } catch (err) {
    console.error("Business analyst tool failed", name, err);
    return "The sales data could not be read right now.";
  }
  return "Unknown tool";
}

export function bizAnalystPromptAddon(): string {
  return `

BUSINESS ANALYST (owner-only, added 2026-11-20). Today's date in India is ${istToday()}. You are also the owner's sales / marketing / finance analyst for Banglar Doi (Bengali sweets: shops, event stalls, website banglardoi.com). Priority: sales first, then marketing, then finance.
- For ANY sales, product, event, target, stock or money question, call the business tools (get_sales_report, compare_periods, get_target_progress, get_event_performance, suggest_event_stock). Never invent or estimate numbers; if data is missing say so (e.g. closing not done for a day).
- Turn "kal", "aaj", "ei mash", "gato saptaho", "last month" into exact dates yourself. Sales figures for a day exist only after that day's closing is synced (nightly), so "aaj" is usually not available yet — say so and offer yesterday.
- Answer like a sharp analyst on WhatsApp: the key number first, then 2-4 short bullet insights (what's up/down, best/worst, why it matters), then ONE concrete suggestion (e.g. which product to push, how much stock to carry, which event to repeat). Use ₹ with Indian commas. Keep it short.
- set_sales_target only when the owner clearly states a target.`;
}
