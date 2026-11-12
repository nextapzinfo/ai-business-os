// Chat-tag names, colours and help text — kept in its own file with NO
// database imports so client components (ClientRow, Broadcasts list) can use
// it too. The tagging logic itself lives in lib/chat-tags.ts.

export const PRICE_ASKED_TAG = "Price asked – not bought";
export const BULK_TAG = "Bulk / Corporate";
export const COMPLAINT_TAG = "Complaint";

// Colour per tag family, for chips on Clients / Profile / Broadcasts.
export function chatTagStyle(tag: string): string {
  if (tag.startsWith("Interested:")) return "bg-teal-50 text-teal-800 ring-1 ring-teal-200";
  if (tag === PRICE_ASKED_TAG) return "bg-orange-100 text-orange-800";
  if (tag === BULK_TAG) return "bg-indigo-100 text-indigo-800";
  if (tag.startsWith("Occasion")) return "bg-pink-100 text-pink-800";
  if (tag === COMPLAINT_TAG) return "bg-red-100 text-red-700 ring-1 ring-red-300";
  if (tag.startsWith("Area:")) return "bg-stone-100 text-stone-700";
  return "bg-gray-100 text-gray-700";
}

export const CHAT_TAG_HELP: Record<string, string> = {
  Interested: "Asked about this product in chat",
  [PRICE_ASKED_TAG]: "Asked the price but hasn't ordered since — follow up",
  [BULK_TAG]: "Asked for a large/bulk or office/corporate order",
  Occasion: "Mentioned an occasion (wedding, birthday, puja…)",
  [COMPLAINT_TAG]: "Raised a complaint that isn't resolved yet",
  Area: "Delivery area mentioned in chat",
};

export function chatTagHelp(tag: string): string {
  const family = tag.includes(":") ? tag.split(":")[0] : tag;
  return CHAT_TAG_HELP[tag] ?? CHAT_TAG_HELP[family] ?? "From WhatsApp chat";
}

// Order chat tags for filter chips: action tags first, then occasions,
// interests, areas.
export function chatTagRank(tag: string): number {
  if (tag === COMPLAINT_TAG) return 0;
  if (tag === PRICE_ASKED_TAG) return 1;
  if (tag === BULK_TAG) return 2;
  if (tag.startsWith("Occasion")) return 3;
  if (tag.startsWith("Interested:")) return 4;
  if (tag.startsWith("Area:")) return 5;
  return 6;
}
