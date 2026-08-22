// Resolves a 6-digit Indian PIN code to its real post-office/area name(s),
// via the same free India Post public API (api.postalpincode.in, no key
// needed) that banglardoi.com's own Admin → Delivery Zone pincode chips
// already use (see delivery-zone-values-field.tsx's fetchAreaName). Added
// 2026-08-22 as ground truth for the WhatsApp AI agent, after a real
// incident: a customer's own free-text address said "Newtown, action area
// 1", then later gave PIN 700001 (which actually resolves to Fairley
// Place/BBD Bagh/Netaji Subhas Road, Kolkata) — the AI told the customer
// "আপনার পিন কোড 700001 অনুযায়ী নিউটাউন এলাকায় আপনার ঠিকানা রয়েছে" (your
// PIN 700001 address is in Newtown), simply parroting back the earlier
// address text instead of actually checking what area the PIN corresponds
// to. This never throws — a lookup failure just means no area names to
// ground the reply with, not a broken save.
export async function resolvePincodeAreaNames(pincode: string): Promise<string[]> {
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`);
    const data = await res.json();
    const offices = data?.[0]?.PostOffice as { Name: string }[] | null;
    if (!offices || offices.length === 0) return [];
    // Multiple post offices can share one PIN — keep it short (max 3
    // unique names) so it fits cleanly into a tool-result line.
    return Array.from(new Set(offices.map((o) => o.Name))).slice(0, 3);
  } catch {
    return [];
  }
}
