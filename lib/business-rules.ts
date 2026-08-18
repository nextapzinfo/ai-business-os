// ---------------------------------------------------------------------------
// Business Rule Engine (Aug 2026) — the ONLY place delivery fees, minimum
// orders, and campaign offers are computed for a RETAIL organization. Every
// exported function here is either a pure calculation over data already
// fetched from the DB, or a direct DB read of DeliveryZone/DeliveryTier/
// ZonePincode/Campaign — nothing here calls the LLM, and nothing in
// lib/llm.ts or the WhatsApp webhook is allowed to compute these numbers
// itself. See ai-business-os-architecture-assessment.md (project docs) for
// the full rationale and the Kolkata/Hooghly/Janmashtami worked example this
// was built against.
//
// Priority hierarchy this file implements, as actual call order (not just a
// comment): Hard Business Rules (zone minimum order) → Live/current data
// (resolveDeliveryZone reads the DB fresh every call, no caching) → Active
// campaign rules (only applied on top of the above, and only when it
// genuinely validates). Conversation state / product knowledge / brand style
// are NOT this file's concern — those are applied only in lib/llm.ts, after
// these numbers are already final and non-negotiable.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";

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

/**
 * resolveDeliveryZone — Hard Business Rules + Live data layer. Looks up
 * which DeliveryZone (if any) a PIN code belongs to for this organization,
 * reading straight from the DB every call (no caching — always current).
 * Returns null (never a guess) when the PIN code isn't configured yet; the
 * caller must then treat delivery as "not yet confirmable for this PIN",
 * never fall back to a default or an invented number.
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
 * validateMinimumOrder — Hard Business Rule. A zone's minOrderAmount is a
 * hard floor: below it, the order can't be delivered to that zone at all,
 * campaign or no campaign (a campaign can only add a better offer on top of
 * an order that already clears this floor, never waive the floor itself).
 */
export function validateMinimumOrder(
  zone: DeliveryZoneInput,
  orderAmount: number
): { valid: boolean; minRequired: number } {
  return { valid: orderAmount >= zone.minOrderAmount, minRequired: zone.minOrderAmount };
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
 * calculateDeliveryCharge — the single function that produces the delivery
 * fee number the AI is allowed to quote. Zone tiers are computed first; an
 * active, validated campaign is then applied ONLY if validateCampaignOffer
 * says it genuinely qualifies — a campaign can only ever improve on the
 * zone's own tiers (free delivery + an optional gift), never raise a fee.
 */
export function calculateDeliveryCharge(
  zone: DeliveryZoneInput,
  orderAmount: number,
  campaign: CampaignInput | null,
  now: Date
): DeliveryChargeResult {
  const sortedTiers = [...zone.tiers].sort((a, b) => a.minAmount - b.minAmount);
  const tier = sortedTiers.find(
    (t) => orderAmount >= t.minAmount && (t.maxAmount === null || orderAmount <= t.maxAmount)
  );
  // No tier matched (e.g. order amount above every configured range) — fall
  // back to the highest configured tier rather than silently charging ₹0.
  const fallbackTier = sortedTiers[sortedTiers.length - 1];
  const effectiveTier = tier ?? fallbackTier ?? null;

  const base: DeliveryChargeResult = effectiveTier
    ? {
        charge: effectiveTier.feeAmount,
        freeDelivery: effectiveTier.feeAmount === 0,
        reason: tier
          ? `${zone.name}: order ₹${orderAmount} falls in the ₹${tier.minAmount}${
              tier.maxAmount !== null ? `–${tier.maxAmount}` : "+"
            } band → ${tier.feeAmount === 0 ? "FREE delivery" : `₹${tier.feeAmount} delivery`}.`
          : `${zone.name}: ₹${orderAmount} is above every configured tier; used the highest configured tier (₹${effectiveTier.feeAmount}) rather than guessing.`,
      }
    : {
        charge: 0,
        freeDelivery: false,
        reason: `${zone.name}: no delivery tiers are configured yet — delivery fee cannot be quoted.`,
      };

  if (!campaign) return base;
  const campaignCheck = validateCampaignOffer(campaign, zone.id, orderAmount, now);
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

  const zone = await resolveDeliveryZone(input.pincode as string, input.organizationId);
  if (!zone) {
    return {
      valid: false,
      blockers: [
        `PIN code ${input.pincode} is not in a configured delivery zone yet — delivery can't be confirmed for this order.`,
      ],
    };
  }

  const minCheck = validateMinimumOrder(zone, input.orderAmount);
  if (!minCheck.valid) {
    return {
      valid: false,
      blockers: [
        `Order total ₹${input.orderAmount} is below the ₹${minCheck.minRequired} minimum order for ${zone.name}.`,
      ],
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
 * backed by a real configured zone.
 */
export async function buildBusinessRulesNote(
  organizationId: string,
  pincode: string | null
): Promise<string | null> {
  if (!pincode) return null;

  const zone = await resolveDeliveryZone(pincode, organizationId);
  if (!zone) {
    return `AUTHORITATIVE DELIVERY INFO for PIN ${pincode}: this PIN code is not yet in a configured delivery zone. Do NOT state a delivery fee or minimum order for this PIN — tell the customer you'll confirm delivery for their area, or offer to connect them with a real person. Never guess or reuse a number from a different area.`;
  }

  const campaign = await resolveActiveCampaign(organizationId, zone.id, new Date());
  const sortedTiers = [...zone.tiers].sort((a, b) => a.minAmount - b.minAmount);
  const tierLines = sortedTiers
    .map(
      (t) =>
        `  ₹${t.minAmount}${t.maxAmount !== null ? `–${t.maxAmount}` : "+"} → ${
          t.feeAmount === 0 ? "FREE delivery" : `₹${t.feeAmount} delivery`
        }`
    )
    .join("\n");

  let note = `AUTHORITATIVE DELIVERY RULES for PIN ${pincode} (${zone.name}) — these are the ONLY numbers you may quote for delivery fee or minimum order for this customer. Never state a different number, and never invent a threshold that isn't listed here:\n`;
  note += `  Minimum order for this zone: ${zone.minOrderAmount > 0 ? `₹${zone.minOrderAmount}` : "no minimum"}\n`;
  note += tierLines.length > 0 ? tierLines + "\n" : "  (no delivery tiers configured yet — do not guess a fee, say you'll confirm)\n";

  if (campaign) {
    const endDate = campaign.endsAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    note += `  ACTIVE CAMPAIGN "${campaign.name}" (through ${endDate}): orders of ₹${campaign.minOrderAmount}+ get ${
      campaign.freeDelivery ? "FREE delivery" : "a special offer"
    }${campaign.freeGiftDescription ? ` + ${campaign.freeGiftDescription} FREE` : ""}. This OVERRIDES the tiers above ONLY when the order meets ₹${campaign.minOrderAmount} — below that, the normal tiers above apply.\n`;
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
  authoritative: { zone: DeliveryZoneInput; campaign: CampaignInput | null; orderAmount: number | null } | null
): string {
  if (!authoritative) return replyText; // no known PIN/zone yet — nothing to check against, leave the reply alone

  const knownAmounts = new Set<number>();
  authoritative.zone.tiers.forEach((t) => knownAmounts.add(Math.round(t.feeAmount)));
  knownAmounts.add(Math.round(authoritative.zone.minOrderAmount));
  authoritative.zone.tiers.forEach((t) => {
    knownAmounts.add(Math.round(t.minAmount));
    if (t.maxAmount !== null) knownAmounts.add(Math.round(t.maxAmount));
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
