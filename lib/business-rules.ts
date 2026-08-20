// ---------------------------------------------------------------------------
// Business Rule Engine (Aug 2026, re-architected 2026-08-20) — the ONLY place
// delivery fees, minimum orders, and campaign offers are computed for a
// RETAIL organization. See ai-business-os-architecture-assessment.md
// (project docs) for the original rationale and the
// Kolkata/Hooghly/Janmashtami worked example this was built against.
//
// 2026-08-20 change — owner's own instruction, once the ecommerce site's own
// Delivery Zone admin (banglardoi.com/admin/delivery) was finished and
// actually being used for real: "delivery ta ekhon theke website follow
// korbe... 2ta thakle AI confused hoye jabe" (delivery should now follow the
// website — two copies would confuse the AI). Two independently-edited
// copies of the same zone/PIN-code/fee data was the real risk (not just
// staleness) — an owner updating a fee on the website would have no reason
// to remember there's a second, separate delivery-rules admin page in THIS
// app that also needed the same edit.
//
// So: DELIVERY FEE, MINIMUM ORDER, COD AVAILABILITY, AND FREE-DELIVERY
// THRESHOLD now come live from banglardoi.com's own /api/delivery/check
// (fetchBanglarDoiDeliveryCheck in lib/banglardoi.ts) every single time —
// never cached, never computed from this app's own DeliveryZone/DeliveryTier
// tables anymore. Those two tables/the admin UI for them still exist (kept
// deliberately, not deleted — see app/dashboard/delivery-rules/page.tsx) but
// are now legacy for fee purposes.
//
// PROMOTIONAL CAMPAIGNS (free delivery / free gift above some order value,
// e.g. "Janmashtami: ₹1,500+ orders in Kolkata get free delivery + a free
// gift") stay exactly as before, unaffected — the owner's own explicit
// instruction: "offer AI-business-os e ja train korbo seta korbe" (offers
// trained here in AI Business OS keep working). banglardoi.com has no
// equivalent "Campaign" concept (it has its own separate Coupon/promo-code
// system for the storefront, which is a different thing — see the note on
// PROMO CODES below) so campaigns remain entirely this app's own domain,
// still configured on the same Delivery Rules admin page, still computed by
// resolveActiveCampaign/validateCampaignOffer below. A campaign only ever
// IMPROVES on the live website fee (free delivery / a free gift on top of
// it) — it never overrides the base fee number itself, which always comes
// from the website.
//
// PROMO / COUPON CODES (a literal redeemable code a customer types, e.g.
// "SAVE10") are explicitly OUT OF SCOPE for this file and for this app's own
// data — owner's instruction: "Promo code only from website only." There is
// no coupon-code concept modelled anywhere in this app; if a customer asks
// about a discount code, the AI should not invent or validate one itself —
// that's the ecommerce site's own Coupon system to answer, not this app's.
//
// The local DeliveryZone/ZonePincode tables (resolveDeliveryZone below) are
// kept ALIVE for exactly one remaining purpose: scoping a Campaign to a
// specific area (e.g. "Kolkata only") via Campaign.deliveryZoneId. They are
// never consulted for a fee number, a minimum order, or whether a PIN is
// deliverable at all — those questions always go to the live website now.
//
// Every exported function here is either a pure calculation, a direct DB
// read (Campaign/DeliveryZone, for the campaign-scoping purpose above), or a
// live call to banglardoi.com (fetchLiveDeliveryQuote) — nothing here calls
// the LLM, and nothing in lib/llm.ts or the WhatsApp webhook is allowed to
// compute these numbers itself.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";
import { fetchBanglarDoiDeliveryCheck, type BanglarDoiDeliveryQuote } from "@/lib/banglardoi";

export interface DeliveryTierInput {
  minAmount: number;
  maxAmount: number | null;
  feeAmount: number;
}

export interface DeliveryZoneInput {
  id: string;
  name: string;
  minOrderAmount: number;
  isActive: boolean;
  tiers: DeliveryTierInput[];
}

export interface CampaignInput {
  id: string;
  name: string;
  isActive: boolean;
  startsAt: Date;
  endsAt: Date;
  minOrderAmount: number;
  freeDelivery: boolean;
  freeGiftDescription: string | null;
  deliveryZoneId: string | null;
}

export interface DeliveryChargeResult {
  charge: number;
  freeDelivery: boolean;
  reason: string; // human-readable, safe to quote to a customer or drop straight into a prompt block
  appliedCampaign?: { name: string; freeGiftDescription: string | null };
}

// Alias, not a re-export — keeps this file's own naming/vocabulary (it talks
// about "the live quote" throughout) decoupled from lib/banglardoi.ts's
// naming, which is about the HTTP client, not the business-rules concept.
export type LiveDeliveryQuote = BanglarDoiDeliveryQuote;

/**
 * fetchLiveDeliveryQuote — Hard Business Rules + Live data layer, now backed
 * by banglardoi.com itself (2026-08-20) rather than a second, locally
 * configured copy of the same zones. Calls the exact same
 * /api/delivery/check endpoint the checkout page's own pincode preview uses
 * and createOrderAction re-validates against, so the AI can never quote a
 * number that disagrees with what the live site would actually charge.
 * Returns null (never a guess) only when the live check genuinely couldn't
 * be reached — the endpoint itself always returns a real quote for any
 * 6-digit PIN (falling back to the site's own flat rate when no specific
 * zone is configured for it), so null here means "try again shortly", not
 * "not deliverable".
 */
export async function fetchLiveDeliveryQuote(
  pincode: string,
  orderAmountInPaise: number
): Promise<LiveDeliveryQuote | null> {
  try {
    return await fetchBanglarDoiDeliveryCheck(pincode, orderAmountInPaise);
  } catch (err) {
    console.error("fetchLiveDeliveryQuote (banglardoi.com /api/delivery/check) failed:", err);
    return null;
  }
}

/**
 * resolveDeliveryZone — looks up which of THIS APP'S OWN (legacy)
 * DeliveryZone rows a PIN code falls into. As of 2026-08-20 this is used for
 * exactly one thing: scoping a Campaign to a specific area via
 * Campaign.deliveryZoneId (see resolveActiveCampaign below). It is NOT used
 * to decide whether a PIN is deliverable, and its zone.tiers/minOrderAmount
 * are NOT the delivery fee or minimum order the AI quotes anymore — that
 * always comes from fetchLiveDeliveryQuote (banglardoi.com) instead. Returns
 * null when the PIN isn't in any locally-configured zone, which simply means
 * "no zone-restricted campaign can apply here" — org-wide campaigns are
 * unaffected.
 */
export async function resolveDeliveryZone(
  pincode: string,
  organizationId: string
): Promise<DeliveryZoneInput | null> {
  const zonePincode = await prisma.zonePincode.findFirst({
    where: { pincode, deliveryZone: { organizationId, isActive: true } },
    include: { deliveryZone: { include: { tiers: true } } },
  });
  if (!zonePincode || !zonePincode.deliveryZone) return null;
  const zone = zonePincode.deliveryZone;
  return {
    id: zone.id,
    name: zone.name,
    minOrderAmount: zone.minOrderAmount,
    isActive: zone.isActive,
    tiers: zone.tiers.map((t: DeliveryTierInput) => ({
      minAmount: t.minAmount,
      maxAmount: t.maxAmount,
      feeAmount: t.feeAmount,
    })),
  };
}

/**
 * resolveActiveCampaign — Active campaign rules layer. Finds the single
 * currently-active, date-valid Campaign applicable to a zone (or an org-wide
 * campaign with no zone restriction). Returns null if none matches; callers
 * must not invent a campaign or assume one exists when this returns null. A
 * zone-specific campaign is preferred over an org-wide one when both match.
 */
export async function resolveActiveCampaign(
  organizationId: string,
  deliveryZoneId: string | null,
  now: Date
): Promise<CampaignInput | null> {
  const campaigns = await prisma.campaign.findMany({
    where: {
      organizationId,
      isActive: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
      OR: [{ deliveryZoneId: null }, ...(deliveryZoneId ? [{ deliveryZoneId }] : [])],
    },
    orderBy: { startsAt: "desc" },
  });
  const zoneSpecific = deliveryZoneId
    ? campaigns.find((c: CampaignInput) => c.deliveryZoneId === deliveryZoneId)
    : undefined;
  const chosen = zoneSpecific ?? campaigns[0] ?? null;
  if (!chosen) return null;
  return {
    id: chosen.id,
    name: chosen.name,
    isActive: chosen.isActive,
    startsAt: chosen.startsAt,
    endsAt: chosen.endsAt,
    minOrderAmount: chosen.minOrderAmount,
    freeDelivery: chosen.freeDelivery,
    freeGiftDescription: chosen.freeGiftDescription,
    deliveryZoneId: chosen.deliveryZoneId,
  };
}

/**
 * resolveAnyActiveCampaign — like resolveActiveCampaign, but doesn't require
 * a zone to already be known: returns the single active, date-valid campaign
 * for this org regardless of any zone restriction it may have. Added
 * 2026-08-20 to fix a real incident: a customer asked "apnader onno kono
 * offer ache?" (any other offers?) before giving their PIN code, and the AI
 * said no offers existed — even though an active Janmashtami campaign
 * genuinely was configured — purely because buildBusinessRulesNote used to
 * return null outright whenever no PIN was known yet, so the campaign was
 * never even looked up. This is ONLY for answering "does an offer exist at
 * all" before a PIN is known — it must NEVER be used to decide whether a
 * specific order actually qualifies (that still always goes through
 * resolveActiveCampaign + validateCampaignOffer with the customer's real
 * zone once their PIN is known, which correctly enforces any zone
 * restriction).
 */
export async function resolveAnyActiveCampaign(organizationId: string, now: Date): Promise<CampaignInput | null> {
  const campaign = await prisma.campaign.findFirst({
    where: {
      organizationId,
      isActive: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    orderBy: { startsAt: "desc" },
  });
  if (!campaign) return null;
  return {
    id: campaign.id,
    name: campaign.name,
    isActive: campaign.isActive,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    minOrderAmount: campaign.minOrderAmount,
    freeDelivery: campaign.freeDelivery,
    freeGiftDescription: campaign.freeGiftDescription,
    deliveryZoneId: campaign.deliveryZoneId,
  };
}

/**
 * validateMinimumOrder — Hard Business Rule. The live quote's minOrderInPaise
 * is a hard floor: below it, the order can't be delivered to that PIN at
 * all, campaign or no campaign (a campaign can only add a better offer on
 * top of an order that already clears this floor, never waive the floor
 * itself). Takes/returns plain rupees (this file's existing convention),
 * converting the quote's paise once here so every caller downstream stays in
 * rupees like before.
 */
export function validateMinimumOrder(
  quote: LiveDeliveryQuote,
  orderAmount: number
): { valid: boolean; minRequired: number } {
  const minRequired = quote.minOrderInPaise / 100;
  return { valid: orderAmount >= minRequired, minRequired };
}

/**
 * validateCampaignOffer — checks whether a specific Campaign genuinely
 * applies to this order right now: active, within its date range, matches
 * the zone restriction (if any), and the order meets its minimum. Kept
 * separate from resolveActiveCampaign so a caller that already has a
 * campaign in hand (e.g. from conversation state) can re-validate it hasn't
 * expired or the order no longer qualifies, without a second DB round-trip.
 */
export function validateCampaignOffer(
  campaign: CampaignInput,
  zoneId: string | null,
  orderAmount: number,
  now: Date
): { applicable: boolean; reason?: string } {
  if (!campaign.isActive) return { applicable: false, reason: "Campaign is not active." };
  if (now < campaign.startsAt || now > campaign.endsAt) {
    return { applicable: false, reason: "Campaign is outside its date range." };
  }
  if (campaign.deliveryZoneId && campaign.deliveryZoneId !== zoneId) {
    return { applicable: false, reason: "Campaign does not apply to this delivery zone." };
  }
  if (orderAmount < campaign.minOrderAmount) {
    return { applicable: false, reason: `Order is below the campaign's ₹${campaign.minOrderAmount} minimum.` };
  }
  return { applicable: true };
}

/**
 * deliveryChargeFromLiveQuote — the single function that produces the
 * delivery fee number the AI is allowed to quote. The base fee always comes
 * from the live banglardoi.com quote; an active, validated campaign is then
 * applied ONLY if validateCampaignOffer says it genuinely qualifies — a
 * campaign can only ever improve on the live fee (free delivery + an
 * optional gift), never raise it or replace it with an invented number.
 * zoneIdForCampaign comes from resolveDeliveryZone (this app's own legacy
 * zone table) purely to check a zone-restricted campaign's scope — it plays
 * no part in the fee itself.
 */
export function deliveryChargeFromLiveQuote(
  quote: LiveDeliveryQuote,
  orderAmountInPaise: number,
  zoneIdForCampaign: string | null,
  campaign: CampaignInput | null,
  now: Date
): DeliveryChargeResult {
  const orderAmount = orderAmountInPaise / 100;
  const base: DeliveryChargeResult = {
    charge: quote.feeInPaise / 100,
    freeDelivery: quote.feeInPaise === 0,
    reason:
      quote.feeInPaise === 0
        ? `banglardoi.com: order ₹${orderAmount} qualifies for FREE delivery to this PIN.`
        : `banglardoi.com: ₹${quote.feeInPaise / 100} delivery fee for this PIN at order value ₹${orderAmount}.`,
  };

  if (!campaign) return base;
  const campaignCheck = validateCampaignOffer(campaign, zoneIdForCampaign, orderAmount, now);
  if (!campaignCheck.applicable || !campaign.freeDelivery) return base;

  return {
    charge: 0,
    freeDelivery: true,
    reason: `${campaign.name} campaign: order ₹${orderAmount} qualifies (min ₹${campaign.minOrderAmount}) → FREE delivery${
      campaign.freeGiftDescription ? ` + ${campaign.freeGiftDescription} free` : ""
    }.`,
    appliedCampaign: { name: campaign.name, freeGiftDescription: campaign.freeGiftDescription },
  };
}

/**
 * validateAddress — Tool Safety layer. A delivery address isn't usable until
 * it has both a street/house-level detail AND a 6-digit PIN code; an area
 * name alone ("Sonarpur") is not enough to resolve a zone or a fee.
 */
export function validateAddress(address: {
  line?: string | null;
  pincode?: string | null;
}): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  const pincodeOk = !!address.pincode && /^[1-9][0-9]{5}$/.test(address.pincode);
  const lineOk = !!address.line && address.line.trim().length >= 8; // rough floor for "has street/house detail", not just a bare area name
  if (!lineOk) missing.push("street/house-level address detail");
  if (!pincodeOk) missing.push("6-digit PIN code");
  return { valid: missing.length === 0, missing };
}

export interface OrderStateInput {
  organizationId: string;
  orderAmount: number;
  pincode: string | null;
  addressLine: string | null;
  isDelivery: boolean; // false = in-store pickup, skips all delivery/address/zone checks
}

export interface OrderValidationResult {
  valid: boolean;
  blockers: string[]; // empty when valid — each entry is a specific, customer-facing-safe reason
}

/**
 * validateOrderState — Tool Safety layer, composing everything above into
 * one pass/fail with specific reasons. app/api/whatsapp/webhook/route.ts
 * calls this BEFORE writing an Order row from the record_order tool — if it
 * returns valid: false, the order is NOT created and the blocking reason is
 * handed back to the model as the tool result, so the model asks the
 * customer for what's missing instead of confirming an order that isn't
 * actually deliverable. This is the hard code-level backstop behind the
 * prompt-level instructions already on PLACE_ORDER_TOOL in lib/llm.ts.
 */
export async function validateOrderState(input: OrderStateInput): Promise<OrderValidationResult> {
  if (!input.isDelivery) {
    // In-store pickup: no address/zone/minimum-order rules apply.
    return { valid: true, blockers: [] };
  }

  const addressCheck = validateAddress({ line: input.addressLine, pincode: input.pincode });
  if (!addressCheck.valid) {
    return {
      valid: false,
      blockers: [`Delivery address is incomplete — missing: ${addressCheck.missing.join(", ")}.`],
    };
  }

  const quote = await fetchLiveDeliveryQuote(input.pincode as string, Math.round(input.orderAmount * 100));
  if (!quote) {
    return {
      valid: false,
      blockers: [`Couldn't confirm delivery for PIN ${input.pincode} right now (a live check failed) — try again in a moment.`],
    };
  }

  const minCheck = validateMinimumOrder(quote, input.orderAmount);
  if (!minCheck.valid) {
    return {
      valid: false,
      blockers: [`Order total ₹${input.orderAmount} is below the ₹${minCheck.minRequired} minimum order for this PIN.`],
    };
  }

  return { valid: true, blockers: [] };
}

/**
 * buildBusinessRulesNote — renders the authoritative delivery/campaign facts
 * for a known PIN code as trusted prompt text, using the same "exact ground
 * truth, injected ahead of fuzzy knowledge" pattern already used for
 * exactProductInfoBlocks in the webhook (see lib/llm.ts buildSystemPrompt).
 * Returns null when no PIN code is known yet — deliberately omits the block
 * rather than guessing, so the prompt never states a number that isn't
 * backed by real data.
 *
 * The delivery fee/minimum-order/COD/free-threshold numbers come live from
 * banglardoi.com every call (fetchLiveDeliveryQuote) — never this app's own
 * DeliveryZone/DeliveryTier tables. Called with orderAmountInPaise=0 (no
 * cart total known yet at prompt-build time), which still returns a fully
 * valid quote — the website's feeTiers schedule is shown in full below so
 * the AI can answer "what will delivery cost for my order" without needing
 * to already know the customer's subtotal.
 */
export async function buildBusinessRulesNote(
  organizationId: string,
  pincode: string | null
): Promise<string | null> {
  if (!pincode) {
    // No PIN yet, so a real delivery fee can't be quoted — but a currently
    // active campaign's EXISTENCE and terms are still worth telling the AI
    // about (see resolveAnyActiveCampaign above for the real incident this
    // fixes). If the campaign turns out to be zone-restricted, we can't yet
    // confirm this specific customer qualifies, so that's flagged as a
    // caveat rather than stated as a fact — the AI is told to ask for the
    // PIN to confirm, not to promise it applies.
    const campaign = await resolveAnyActiveCampaign(organizationId, new Date());
    if (!campaign) return null;

    const endDate = campaign.endsAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const areaCaveat = campaign.deliveryZoneId
      ? " This may be limited to specific delivery areas — ask for the customer's PIN code to confirm it applies to them before promising it."
      : "";
    return `ACTIVE CAMPAIGN "${campaign.name}" (through ${endDate}): orders of ₹${campaign.minOrderAmount}+ get ${
      campaign.freeDelivery ? "FREE delivery" : "a special offer"
    }${campaign.freeGiftDescription ? ` + ${campaign.freeGiftDescription} FREE` : ""}.${areaCaveat} If a customer asks whether you have any offers, discounts, or deals, mention this confidently and specifically — never say there are no offers/deals when an active campaign like this exists.`;
  }

  const quote = await fetchLiveDeliveryQuote(pincode, 0);
  if (!quote) {
    return `AUTHORITATIVE DELIVERY INFO for PIN ${pincode}: couldn't reach banglardoi.com's live delivery check just now. Do NOT state a delivery fee or minimum order for this PIN — tell the customer you'll confirm and follow up, or offer to connect them with a real person. Never guess or reuse a number from a different area.`;
  }

  // Local zone lookup is now ONLY used to scope a Campaign to a specific
  // area — the numbers below always come from the live quote above, never
  // from this local zone's own (legacy) tiers/minOrderAmount.
  const zone = await resolveDeliveryZone(pincode, organizationId);
  const campaign = await resolveActiveCampaign(organizationId, zone?.id ?? null, new Date());

  const sortedTiers = [...quote.feeTiers].sort((a, b) => a.uptoInPaise - b.uptoInPaise);
  let prevFloor = 0;
  const tierLines = sortedTiers
    .map((t) => {
      const line = `  ₹${prevFloor}–₹${t.uptoInPaise / 100} → ${t.feeInPaise === 0 ? "FREE delivery" : `₹${t.feeInPaise / 100} delivery`}`;
      prevFloor = t.uptoInPaise / 100 + 1;
      return line;
    })
    .join("\n");

  let note = `AUTHORITATIVE DELIVERY RULES for PIN ${pincode} — sourced live from banglardoi.com just now; these are the ONLY numbers you may quote for delivery fee, minimum order, or COD availability for this customer. Never state a different number, and never invent a threshold that isn't listed here:\n`;
  note += `  Minimum order for this PIN: ${quote.minOrderInPaise > 0 ? `₹${quote.minOrderInPaise / 100}` : "no minimum"}\n`;
  note +=
    tierLines.length > 0
      ? tierLines + `\n  Above every bracket above → ${quote.feeInPaise === 0 ? "FREE delivery" : `₹${quote.feeInPaise / 100} delivery`}\n`
      : `  Delivery fee: ${quote.feeInPaise === 0 ? "FREE delivery" : `₹${quote.feeInPaise / 100}`}${
          quote.freeDeliveryThresholdInPaise ? ` (FREE above ₹${quote.freeDeliveryThresholdInPaise / 100})` : ""
        }\n`;
  note += `  Cash on Delivery: ${quote.codAllowed ? "available" : "NOT available — prepaid/online payment only"} for this PIN\n`;

  if (campaign) {
    const endDate = campaign.endsAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    note += `  ACTIVE CAMPAIGN "${campaign.name}" (through ${endDate}): orders of ₹${campaign.minOrderAmount}+ get ${
      campaign.freeDelivery ? "FREE delivery" : "a special offer"
    }${campaign.freeGiftDescription ? ` + ${campaign.freeGiftDescription} FREE` : ""}. This OVERRIDES the delivery fee above ONLY when the order meets ₹${campaign.minOrderAmount} — below that, the fee above applies as normal.\n`;
  }

  return note;
}

// ---------------------------------------------------------------------------
// Business Claim Validation backstop — checks the AI's OWN final reply text
// for delivery-fee/minimum-order/campaign claims that conflict with the
// authoritative numbers above, and strips (never rewrites-to-a-guess) any
// mismatched sentence. Deliberately conservative: only runs when we actually
// have authoritative numbers to check against (a known, resolved zone), and
// only touches sentences that clearly reference delivery/minimum/free/
// campaign wording — mirrors the same "drop rather than risk" philosophy
// already used by stripHallucinatedProductListings() in lib/llm.ts.
// ---------------------------------------------------------------------------
const CLAIM_KEYWORDS = /(delivery|shipping|minimum order|min order|free deliver|campaign|offer)/i;
const RUPEE_AMOUNT = /₹\s?[\d,]+/g;

export function validateBusinessClaims(
  replyText: string,
  authoritative: { quote: LiveDeliveryQuote; campaign: CampaignInput | null } | null
): string {
  if (!authoritative) return replyText; // no known PIN/live quote yet — nothing to check against, leave the reply alone

  const { quote } = authoritative;
  const knownAmounts = new Set<number>();
  knownAmounts.add(Math.round(quote.feeInPaise / 100));
  knownAmounts.add(Math.round(quote.minOrderInPaise / 100));
  if (quote.freeDeliveryThresholdInPaise != null) {
    knownAmounts.add(Math.round(quote.freeDeliveryThresholdInPaise / 100));
  }
  quote.feeTiers.forEach((t) => {
    knownAmounts.add(Math.round(t.uptoInPaise / 100));
    knownAmounts.add(Math.round(t.feeInPaise / 100));
  });
  if (authoritative.campaign) {
    knownAmounts.add(Math.round(authoritative.campaign.minOrderAmount));
    knownAmounts.add(0); // free delivery
  }

  const sentences = replyText.split(/(?<=[.!?\n])\s+/);
  const kept = sentences.filter((sentence) => {
    if (!CLAIM_KEYWORDS.test(sentence)) return true;
    const amounts = sentence.match(RUPEE_AMOUNT);
    if (!amounts) return true; // claim-shaped sentence but no ₹ number in it — nothing to verify, leave it
    const allKnown = amounts.every((raw) => {
      const n = Number(raw.replace(/[₹,\s]/g, ""));
      return knownAmounts.has(n);
    });
    return allKnown; // drop the sentence entirely if any quoted amount doesn't match a real configured number
  });

  return kept.join(" ").replace(/\s+/g, " ").trim() || replyText; // never return an empty reply — fall back to the original if stripping ate everything
}
