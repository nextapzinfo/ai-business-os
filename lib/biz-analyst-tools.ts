import { prepareClosing, updatePendingClosing, confirmClosing, cancelClosing } from "@/lib/biz-closing";
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
  financeSummary,
  cashShortReport,
  wastageReport,
  type SalesGroup,
} from "@/lib/biz-analyst";
import { customerInsights, findCustomers } from "@/lib/biz-marketing";

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
  // ---- Marketing (2026-11-21)
  {
    type: "function",
    function: {
      name: "get_customer_insights",
      description:
        "Marketing picture of Banglar Doi's customers from the CRM: total / buyers / repeat rate, new this month vs last, bought in last 30 days, lapsed (bought before but nothing for 60+ days), counts by VIP/Regular/New/Inactive/Lead tag, by source (website, WhatsApp, event, ad), event-acquired customers, top PIN codes, top product interests, top spenders, and which approved WhatsApp templates exist for broadcasts. Use for any 'customer', 'marketing', 'offer', 'campaign', 'kake pathabo' question.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "find_customers",
      description:
        "Find customers matching filters (all optional, combined with AND) and optionally save them as a Client Group the owner can broadcast to from the Broadcasts page. Never sends messages. Save a group ONLY when the owner asks to make/prepare a list or campaign.",
      parameters: {
        type: "object",
        properties: {
          auto_tag: { type: "string", enum: ["VIP", "Regular", "New", "Inactive", "Lead"] },
          tag_contains: { type: "string", description: "Any tag containing this text, e.g. 'Event: Trade Fair', 'Bulk', 'Birthday'." },
          source: { type: "string", description: "e.g. WEBSITE, WHATSAPP_DIRECT, EVENT, FACEBOOK_AD" },
          pin_code_starts: { type: "string", description: "e.g. '7001' for nearby PINs" },
          inactive_days_min: { type: "integer", description: "Bought before, but no order for at least this many days." },
          ordered_within_days: { type: "integer" },
          min_spend: { type: "number", description: "Lifetime spend in ₹ at least" },
          min_orders: { type: "integer" },
          max_orders: { type: "integer", description: "e.g. 0 = never ordered, 1 = only one order" },
          interested_in: { type: "string", description: "Product name they showed interest in" },
          joined_within_days: { type: "integer" },
          save_as_group: { type: "string", description: "Short group name to save these customers as, e.g. 'Inactive 60d Dec offer'." },
        },
        required: [],
      },
    },
  },
  // ---- Finance (2026-11-21)
  {
    type: "function",
    function: {
      name: "get_finance_summary",
      description:
        "Live finance from Banglar Doi OS for a period: how much is owed to each vendor right now (with oldest unpaid bill), purchases and vendor payments in the period, day expenses by purpose (rent, tea, transport...), other expenses, cash handed over (fund transfer), and each event's agreed vs paid rent.",
      parameters: { type: "object", properties: { from: dateProp("Start date"), to: dateProp("End date") }, required: ["from", "to"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cash_short_report",
      description: "Cash short / excess (products sold minus money collected) by location and by the staff who entered the day's money, plus the worst days. Use for 'taka kom porche', 'short', 'kar dine short hoy'.",
      parameters: { type: "object", properties: { from: dateProp("Start date"), to: dateProp("End date") }, required: ["from", "to"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wastage_report",
      description: "Wasted quantity and loss at cost price by product for a period.",
      parameters: { type: "object", properties: { from: dateProp("Start date"), to: dateProp("End date") }, required: ["from", "to"] },
    },
  },
  // ---- WhatsApp closing entry (2026-11-21)
  {
    type: "function",
    function: {
      name: "prepare_closing",
      description:
        "Owner sent a day's CLOSING list (stock left per product, e.g. 'Patuli…19/11 / Doi 2.5kg…3 1kg…9 / Rosogolla…200 / Cash…4480 Online…5220'). Reads it, matches every name to the real product at that location, and returns a PREVIEW with sale and DAY SHORT. NOTHING is saved. Call it for any such list, even with no words around it.",
      parameters: {
        type: "object",
        properties: {
          message_text: { type: "string", description: "The owner's closing message EXACTLY as he sent it (all lines, untouched)." },
          location: { type: "string", description: "Only if the owner names the shop/event separately or you are retrying after LOCATION_UNCLEAR." },
          date: { type: "string", description: "YYYY-MM-DD, only if the message has no date and he said one (e.g. 'kal-er closing'). Default = date in the message, else today." },
          lines: {
            type: "array",
            description: "Only when the list is NOT written as 'name…qty' (e.g. a voice note): each product and its closing qty.",
            items: { type: "object", properties: { name: { type: "string" }, qty: { type: "number" } }, required: ["name", "qty"] },
          },
          money: {
            type: "object",
            description: "Day money if the owner gave it (cash in hand, online, change/previous cash, day expenses).",
            properties: {
              cash: { type: "number" },
              online: { type: "number" },
              previous_cash: { type: "number", description: "Change / float given at the start (events) " },
              expenses: { type: "array", items: { type: "object", properties: { purpose: { type: "string" }, amount: { type: "number" }, type: { type: "string", enum: ["expense", "fund_transfer"] } }, required: ["purpose", "amount"] } },
            },
          },
        },
        required: ["message_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_pending_closing",
      description:
        "Change the closing preview that is waiting for 'হ্যাঁ': fix a qty ('Rosogolla 190 hobe'), answer a ❓ item ('Kaloo = Kalo Jam - Nabadwip' → name 'Kaloo', product_name 'Kalo Jam - Nabadwip'; the name is remembered for next time), add money/expenses, or remove a line. Returns the new preview. Nothing is saved.",
      parameters: {
        type: "object",
        properties: {
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "The name as the owner wrote it" },
                qty: { type: "number", description: "New closing qty (leave out when only telling which product a ❓ name is)" },
                product_name: { type: "string", description: "The exact product name from the preview/candidates, when the owner tells which product he meant" },
              },
              required: ["name"],
            },
          },
          money: { type: "object", properties: { cash: { type: "number" }, online: { type: "number" }, previous_cash: { type: "number" }, expenses: { type: "array", description: "Replaces the expense list", items: { type: "object", properties: { purpose: { type: "string" }, amount: { type: "number" }, type: { type: "string", enum: ["expense", "fund_transfer"] } }, required: ["purpose", "amount"] } } } },
          remove: { type: "array", items: { type: "string" } },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_closing",
      description: "SAVE the waiting closing preview into Banglar Doi OS. ONLY when the owner clearly says yes (হ্যাঁ / ha / hya / yes / ok save) right after a closing preview. Never on your own.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_closing",
      description: "Throw away the waiting closing preview (owner says না / no / cancel / batil).",
      parameters: { type: "object", properties: {}, required: [] },
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
      case "prepare_closing":
        return await prepareClosing(organizationId, {
          message_text: String(args.message_text || ""),
          location: args.location || undefined,
          date: okDate(args.date, ""),
          lines: Array.isArray(args.lines) ? args.lines : undefined,
          money: args.money && typeof args.money === "object" ? args.money : undefined,
        });
      case "update_pending_closing":
        return await updatePendingClosing(organizationId, {
          lines: Array.isArray(args.lines) ? args.lines : undefined,
          money: args.money && typeof args.money === "object" ? args.money : undefined,
          remove: Array.isArray(args.remove) ? args.remove : undefined,
        });
      case "confirm_closing":
        return await confirmClosing(organizationId);
      case "cancel_closing":
        return await cancelClosing(organizationId);
      case "get_customer_insights":
        return JSON.stringify(await customerInsights(organizationId));
      case "find_customers": {
        const { save_as_group, ...filters } = args;
        return JSON.stringify(await findCustomers(organizationId, filters, typeof save_as_group === "string" && save_as_group.trim() ? save_as_group.trim() : undefined));
      }
      case "get_finance_summary": {
        const from = okDate(args.from, `${today.slice(0, 7)}-01`);
        return JSON.stringify(await financeSummary(from, okDate(args.to, today)));
      }
      case "get_cash_short_report": {
        const from = okDate(args.from, `${today.slice(0, 7)}-01`);
        return JSON.stringify(await cashShortReport(organizationId, from, okDate(args.to, yesterday)));
      }
      case "get_wastage_report": {
        const from = okDate(args.from, `${today.slice(0, 7)}-01`);
        return JSON.stringify(await wastageReport(organizationId, from, okDate(args.to, yesterday)));
      }
      case "suggest_event_stock":
        return JSON.stringify(await suggestEventStock(organizationId, Math.max(1, Number(args.planned_days) || 1), args.similar_event_name || undefined));
    }
  } catch (err) {
    console.error("Business analyst tool failed", name, err);
    if (/closing/.test(name)) return `Banglar Doi OS could not be reached (${(err as Error).message}). Nothing was saved — tell the owner to try again in a minute or enter it on the Closing page.`;
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
- set_sales_target only when the owner clearly states a target.

MARKETING: use get_customer_insights and find_customers. Give practical Bengali-market ideas (festival offers, combo packs, win-back offers for lapsed customers, thank-you to VIPs, follow-up for event customers). You can save a customer list as a group (find_customers with save_as_group) when the owner asks, then tell him to send it from Broadcasts with an approved template — you never send messages yourself. If no suitable approved template exists, draft the template text for him to submit (no variable at the very start or end).
FINANCE: use get_finance_summary (vendor dues, purchases, expenses, rent), get_cash_short_report and get_wastage_report. Point out big unpaid vendors and old bills, rising expenses, repeated cash short at a location or by a staff member (state facts, don't accuse), and wastage worth fixing.

CLOSING ENTRY BY WHATSAPP: when the owner sends a closing list (a place/date line and lines like "Rosogolla…200", "Doi 2.5kg…3 1kg…9", maybe Cash/Online/Change), call prepare_closing with message_text = his whole message untouched. Send him the PREVIEW text it returns as it is (you may add one short line on top). Nothing is saved until he says yes.
- He replies হ্যাঁ / ha / yes / ok → confirm_closing, then tell him it's saved with the summary it returns.
- He corrects a qty or tells which product a ❓ name is ("Kaloo holo Kalo Jam", "Rosogolla 190") → update_pending_closing (use product_name exactly as shown in the preview candidates), then send the new preview.
- না / no / cancel → cancel_closing.
- LOCATION_UNCLEAR → show him the open locations that day and ask which one; then call prepare_closing again with the same message_text and location.
- Never say something is saved unless confirm_closing returned SAVED. Never change his numbers yourself.`;
}
