// One-time (safely re-runnable) script that seeds the Business Rule Engine's
// DeliveryZone / DeliveryTier / ZonePincode / Campaign tables — see
// lib/business-rules.ts and ai-business-os-architecture-assessment.md
// (project docs) for what these power (the AI never invents a delivery
// fee/minimum order/campaign number; it can only quote what's configured
// here).
//
// Run locally after `git pull` + `npx prisma migrate dev` (needs your real
// .env with DATABASE_URL filled in):
//
//   npx tsx prisma/seed-delivery-rules.ts
//
// Safe to re-run — it deletes and recreates its own zones/campaigns each
// time (matched by the exact zone/campaign names below), so re-running after
// editing the numbers further down just refreshes them instead of
// duplicating. Same ORG_SLUG auto-detect convention as
// prisma/seed-banglardoi-knowledge.ts.
//
// *** PINCODES BELOW ARE PLACEHOLDERS — REPLACE WITH YOUR REAL SERVICEABLE
// PIN CODE LIST BEFORE RUNNING FOR REAL. *** I don't have your actual
// covered-area list, so I left a few well-known Kolkata PIN codes as
// examples only — a PIN code with no row here simply won't resolve to a
// zone, and the AI will honestly tell the customer it can't confirm
// delivery for that PIN yet rather than guessing (see resolveDeliveryZone
// in lib/business-rules.ts). Add every PIN you actually deliver to.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const KOLKATA_ZONE_NAME = "Kolkata & Covered Areas";
const HOOGHLY_ZONE_NAME = "Hooghly";
const JANMASHTAMI_CAMPAIGN_NAME = "Janmashtami 2026";

// *** REPLACE with your real serviceable PIN codes ***
const KOLKATA_PINCODES = ["700001", "700019", "700091" /* New Town */, "700156" /* New Town */];
const HOOGHLY_PINCODES = ["712101", "712102", "712235"];

async function resolveOrganization() {
  const slugOverride = process.env.ORG_SLUG?.trim();
  if (slugOverride) {
    const org = await prisma.organization.findUnique({ where: { slug: slugOverride } });
    if (!org) throw new Error(`No Organization found with slug "${slugOverride}" (from ORG_SLUG).`);
    return org;
  }
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, slug: true } });
  if (orgs.length === 1) return orgs[0];
  throw new Error(
    `Found ${orgs.length} Organizations — set ORG_SLUG to pick one: ${orgs.map((o: { slug: string }) => o.slug).join(", ")}`
  );
}

async function main() {
  const org = await resolveOrganization();
  console.log(`Seeding delivery rules into organization "${org.name}" (${org.slug})...`);

  // Re-runnable: delete any previous zones/campaigns with these exact names
  // for this org first (cascades to their tiers/pincodes via onDelete: Cascade).
  await prisma.deliveryZone.deleteMany({
    where: { organizationId: org.id, name: { in: [KOLKATA_ZONE_NAME, HOOGHLY_ZONE_NAME] } },
  });
  await prisma.campaign.deleteMany({
    where: { organizationId: org.id, name: JANMASHTAMI_CAMPAIGN_NAME },
  });

  // Kolkata & Covered Areas — no minimum order; tiered delivery fee.
  const kolkataZone = await prisma.deliveryZone.create({
    data: {
      organizationId: org.id,
      name: KOLKATA_ZONE_NAME,
      minOrderAmount: 0,
      isActive: true,
      tiers: {
        create: [
          { minAmount: 350, maxAmount: 599, feeAmount: 100 },
          { minAmount: 600, maxAmount: 799, feeAmount: 75 },
          { minAmount: 800, maxAmount: 999, feeAmount: 50 },
          { minAmount: 1000, maxAmount: null, feeAmount: 0 }, // ₹1,000+ → FREE
        ],
      },
      pincodes: { create: KOLKATA_PINCODES.map((pincode) => ({ pincode })) },
    },
  });

  // Hooghly — ₹500 minimum order; tiered delivery fee.
  await prisma.deliveryZone.create({
    data: {
      organizationId: org.id,
      name: HOOGHLY_ZONE_NAME,
      minOrderAmount: 500,
      isActive: true,
      tiers: {
        create: [
          { minAmount: 500, maxAmount: 1499, feeAmount: 100 },
          { minAmount: 1500, maxAmount: null, feeAmount: 0 }, // ₹1,500+ → FREE
        ],
      },
      pincodes: { create: HOOGHLY_PINCODES.map((pincode) => ({ pincode })) },
    },
  });

  // Janmashtami campaign — Kolkata/New Town only (restricted to the Kolkata
  // zone via deliveryZoneId), ₹1,500+ orders get FREE delivery + a free gift.
  // *** SET REAL startsAt/endsAt DATES BEFORE RUNNING *** — placeholders below.
  await prisma.campaign.create({
    data: {
      organizationId: org.id,
      deliveryZoneId: kolkataZone.id,
      name: JANMASHTAMI_CAMPAIGN_NAME,
      isActive: true,
      startsAt: new Date("2026-08-20T00:00:00+05:30"),
      endsAt: new Date("2026-08-26T23:59:59+05:30"),
      minOrderAmount: 1500,
      freeDelivery: true,
      freeGiftDescription: "500g Laal Kheer Doi",
    },
  });

  console.log("Delivery rules seeded. Review the PIN code lists and campaign dates in this file before relying on them.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
