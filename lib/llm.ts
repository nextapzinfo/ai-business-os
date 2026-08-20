const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

type SourceChunk = { title: string; content: string };

// Prior turns of the SAME conversation, oldest first — without this, every
// incoming message is answered in total isolation (the model never sees what
// was said before). That's what broke replies like a bare "Yes" confirming an
// order, or "50" answering "how many pieces": with no history, the model has
// nothing to resolve those against and falls back to a generic greeting.
export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

// Real token counts OpenAI returns with every response — this is what powers
// the Billing page's exact (not estimated) OpenAI cost figure.
export type TokenUsage = { promptTokens: number; completionTokens: number };
export type AiCallResult = { answer: string; usage: TokenUsage };

function extractUsage(data: any): TokenUsage {
  return {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };
}

export type AgentProfileInput = {
  businessName?: string | null;
  businessDescription?: string | null;
  coreIdentity?: string | null; // free-text persona paragraph — see buildSystemPrompt for how this overrides the default opening line
  customInstructions?: string | null;
  brandLanguage?: string | null; // JSON string: { wordsToUse, wordsToAvoid, terminology: {from,to}[] }
  tone?: string | null; // friendly, formal, casual, traditional, premium, luxury, professional, humorous
  languageStyle?: string | null; // bn, en, mixed
};

// "Brand personality" presets — lets the same underlying AI represent very
// different businesses (a traditional sweet shop vs. a luxury salon vs. a CA
// firm) just by picking a tone here, instead of hand-writing a new prompt
// for each one.
const TONE_TEXT: Record<string, string> = {
  friendly: "warm, friendly, and approachable",
  formal: "polite, respectful, and formal",
  casual: "casual and conversational, like chatting with a friend",
  traditional:
    "rooted in tradition and cultural warmth — respectful of local customs, heritage, and courteous forms of address",
  premium: "polished and premium — confident, refined, and a little exclusive, like a high-end brand",
  luxury:
    "luxurious and indulgent — elegant, exclusive, and aspirational, emphasizing quality, craftsmanship, and prestige",
  professional: "polished, businesslike, and efficient — professional and competent without being cold",
  humorous:
    "light-hearted and witty — friendly humor and playful language, while staying respectful and genuinely helpful",
};

const LANGUAGE_TEXT: Record<string, string> = {
  bn: "Always reply in Bengali (Bangla). Use natural, grammatically correct Bengali — never invent a Bengali word or phrase you're not sure is real.",
  en: "Always reply in English.",
  // Real incident (2026-08-20): a customer chatting entirely in Bengali got
  // a reply with a stray, unrelated Hindi phrase ("इनमें से") stitched into
  // an otherwise-Bengali sentence. Root cause: this text used to promise
  // "if they write in Hindi, reply in Hindi" as one of several mirrored
  // languages, while the separate language-quality rule further down this
  // file (search "no stray Cyrillic, Hindi") flatly forbids switching into
  // any language other than Bengali/English — the SAME prompt was telling
  // the model both "Hindi is a valid reply language" and "never use Hindi."
  // This business only actually operates in Bengali/English, so mirroring
  // is now scoped to just those two, with any other language (Hindi
  // included) explicitly redirected to English rather than attempted — that
  // resolves the contradiction and matches the language-quality rule.
  mixed:
    "Mirror whether the customer writes in English or Bengali — if they write in English, reply in English; if they write in Bengali script, reply in Bengali script. Don't default to Bengali just because the business is Bengali. The one special case: if the customer writes Banglish (Bengali words spelled out in English/Roman letters, e.g. 'ghee kamon hobe'), reply in proper Bengali script (বাংলা), not in Roman letters — never reply in Banglish yourself. If the customer writes in some other language (e.g. Hindi, or anything else), reply in English instead of attempting that language — never mix in even a single stray word from a language other than Bengali/English (see the language-quality rule below). You can naturally keep English brand/product names mixed into a reply in any language. Only use words and phrases in a language you are certain are grammatically correct and actually mean what you intend; if you're not sure how to say something naturally in Bengali, say that part in English instead of guessing or inventing a word.",
};

// Turns the owner's structured word-swap/vocabulary settings into a short
// instruction block. Stored as a JSON string so the Agent Studio UI can offer
// a friendly table instead of a free-text box; parsing failures are swallowed
// so a malformed value never breaks the whole reply.
function buildBrandLanguageNote(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as {
      wordsToUse?: string[];
      wordsToAvoid?: string[];
      terminology?: { from: string; to: string }[];
    };

    const lines: string[] = [];

    const wordsToUse = (parsed.wordsToUse ?? []).filter((w) => w?.trim());
    if (wordsToUse.length > 0) {
      lines.push(`Prefer these words/phrases where natural: ${wordsToUse.join(", ")}.`);
    }

    const wordsToAvoid = (parsed.wordsToAvoid ?? []).filter((w) => w?.trim());
    if (wordsToAvoid.length > 0) {
      lines.push(`Never use these generic words/phrases: ${wordsToAvoid.join(", ")}.`);
    }

    const terminology = (parsed.terminology ?? []).filter((t) => t?.from?.trim() && t?.to?.trim());
    if (terminology.length > 0) {
      const rules = terminology.map((t) => `Never say "${t.from}" — always say "${t.to}" instead.`).join(" ");
      lines.push(rules);
    }

    if (lines.length === 0) return "";

    return `\n\nBrand language — this business has its own vocabulary, use it exactly as given below instead of generic terms. This matters a lot for sounding like a real member of the team rather than a generic assistant:\n${lines.join(
      "\n"
    )}`;
  } catch {
    return "";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Baseline Bengali corrections that apply to EVERY business on this platform,
// regardless of what the owner has configured in Brand Language — these fix
// mistakes the underlying model tends to make on its own (literal English/
// foreign-word translations, stiff "AI-translated"-sounding phrasing, a
// stray Cyrillic word) rather than anything business-specific. Added after a
// real incident: a Teach AI style note asking for natural Bengali was saved
// as a Knowledge Base document, which only reaches the model if it's among
// the top-5 RAG matches for that customer's specific question — a generic
// writing-style note about "sorbhaja" rarely wins that similarity search
// against the actual Sorbhaja product data, so the correction silently never
// applied. These defaults don't depend on RAG retrieval at all — they run on
// every single reply. Ordered with longer/more-specific phrases BEFORE the
// single-word rules they contain, so e.g. "ক্রিম (সোর)" → "দুধের সর" fires
// before the bare "সোর" → "সর" rule would otherwise partially consume it and
// leave an awkward leftover like "ক্রিম (সর)".
const DEFAULT_TERMINOLOGY: { from: string; to: string }[] = [
  { from: "দুধের ক্রিম (সোর)", to: "দুধের সর" }, // must come before the shorter rule below, or "দুধের ক্রিম (সোর)" becomes "দুধের দুধের সর"
  { from: "ক্রিম (সোর)", to: "দুধের সর" },
  { from: "চিনির সিরাপ", to: "চিনির রস" },
  { from: "বিস্কিটের মতো ক্রিস্পি", to: "হালকা খাস্তা" },
  { from: "এর মিষ্টতা খুবই সঠিক", to: "পরিমিত মিষ্টি" },
  { from: "упаковка", to: "প্যাকেজ" }, // stray Cyrillic word seen in a real reply
  { from: "উপাকভা", to: "প্যাকেজ" }, // garbled Bengali transliteration of the above, also seen in a real reply
  { from: "সোর", to: "সর" },
  { from: "ক্রিমী", to: "ক্রিমি" },
];

// Prompt instructions ("never say X, always say Y") are a strong hint to the
// model, not a guarantee — with several swap rules plus tone/language/custom
// instructions all competing for the model's attention, an occasional miss is
// normal, especially on a smaller model like gpt-4o-mini. This runs AFTER the
// model replies, doing a real find-and-replace — first the platform-wide
// DEFAULT_TERMINOLOGY above, then this business's own Brand Language pairs —
// so a swap like "পণ্য" → "মিষ্টি" is 100% guaranteed in what the customer
// actually receives, regardless of what the model wrote. Case-insensitive,
// whole-WORD substring match (no stemming/pluralization — "Products" won't
// match a "Product" rule); applied in order, so a later rule can re-match an
// earlier rule's output.
//
// WORD-BOUNDARY FIX (2026-08-20) — real incident: a short owner-taught rule
// for a unit abbreviation (a "g"/"gm" → "গ্রাম" style pair, for weights like
// "500g") was matching as a bare substring with no boundary check, so it
// also fired INSIDE unrelated English words that happen to contain that
// same letter sequence — "Ghee" came out as "গhee" (only the leading "G"
// swapped) in a real customer-facing reply. Boundaries use \p{L}/\p{N}
// (Unicode letter/number), not plain regex \b (which only understands
// ASCII a-z0-9_ and would silently fail to protect Bengali text on either
// side of a match) — this correctly stops a short rule from matching
// mid-word in EITHER script. Trade-off, worth knowing: a `from` term that's
// meant to match inside an inflected/agglutinated Bengali form (a suffix
// glued on with no space) will now correctly NOT match there either — same
// "only touch what's unambiguous" conservatism used elsewhere in this file
// (e.g. stripHallucinatedProductListings), preferring a missed swap over a
// corrupted word.
const WORD_CHAR = "\\p{L}\\p{N}";
function wholeWordRegex(term: string): RegExp {
  return new RegExp(`(?<![${WORD_CHAR}])${escapeRegExp(term)}(?![${WORD_CHAR}])`, "giu");
}

export function applyTerminologySwaps(text: string, brandLanguageRaw: string | null | undefined): string {
  if (!text) return text;

  let ownerPairs: { from: string; to: string }[] = [];
  if (brandLanguageRaw) {
    try {
      const parsed = JSON.parse(brandLanguageRaw) as { terminology?: { from: string; to: string }[] };
      ownerPairs = (parsed.terminology ?? []).filter((t) => t?.from?.trim() && t?.to?.trim());
    } catch {
      // malformed JSON — ignore this business's own pairs, defaults below still apply
    }
  }

  const pairs = [...DEFAULT_TERMINOLOGY, ...ownerPairs];
  if (pairs.length === 0) return text;

  let result = text;
  for (const { from, to } of pairs) {
    const fromTrimmed = from.trim();
    const toTrimmed = to.trim();
    if (fromTrimmed.toLowerCase() === toTrimmed.toLowerCase()) continue; // no-op rule

    // A rule like "kheer doi" → "laal kheer doi" must NOT turn an already-
    // correct "Laal Kheer Doi" into "Laal laal kheer doi" — "kheer doi" is a
    // real substring of the correct output too. Find every span where the
    // TARGET text already occurs first, and skip any `from` match that
    // falls inside one of those spans — only replace genuinely bare,
    // not-yet-fixed occurrences.
    const toRegex = wholeWordRegex(toTrimmed);
    const protectedRanges: [number, number][] = [];
    let m: RegExpExecArray | null;
    while ((m = toRegex.exec(result))) {
      protectedRanges.push([m.index, m.index + m[0].length]);
    }

    const fromRegex = wholeWordRegex(fromTrimmed);
    result = result.replace(fromRegex, (match, offset) => {
      const isAlreadyCorrect = protectedRanges.some(([start, end]) => offset >= start && offset < end);
      return isAlreadyCorrect ? match : toTrimmed;
    });
  }
  return result;
}

// Known single-product attribute labels the model tends to bullet out into a
// spec sheet (স্বাদ/Taste, মূল্য/Price, etc.) — deliberately a curated list,
// not "any bold word before a colon", so this never touches a legitimate
// multi-DIFFERENT-product listing (those use em-dash separated lines with a
// PRODUCT NAME in bold, not a generic attribute word before a colon).
const ATTRIBUTE_BULLET_LABELS = new Set([
  "বর্ণনা", "স্বাদ", "মিষ্টতা", "মিষ্টি", "প্যাকেজিং", "প্যাকেট", "মূল্য", "দাম",
  "টেক্সচার", "বৈশিষ্ট্য", "উপকরণ", "সংরক্ষণ", "সাইজ", "পরিমাণ", "গুণমান", "কোয়ালিটি", "ওজন",
  "description", "taste", "texture", "packaging", "price", "ingredients", "storage",
  "features", "size", "quantity", "quality", "weight",
]);

const ATTRIBUTE_BULLET_LINE = /^[•\-]\s*\*([^*]{1,24})\*\s*[:：]\s*(.+)$/;

// Second deterministic safety net, added after a real incident where an
// owner explicitly taught (via update_style_rule, so it WAS in
// customInstructions — always injected) "don't use bullet points, write in
// normal paragraphs", and the very next live WhatsApp reply still bulleted a
// single product's attributes anyway. Same lesson as applyTerminologySwaps
// above: instructions — even standing, always-injected ones — are a strong
// hint to the model, not a guarantee. This runs AFTER generation and merges
// 2+ consecutive "• *KnownAttributeLabel*: content" lines into one flowing
// paragraph, dropping the bullet/bold-label packaging entirely, so the
// spec-sheet look is gone from what the customer actually receives no matter
// what the model wrote.
export function flattenAttributeBulletLines(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const output: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const run: string[] = [];
    let j = i;
    while (j < lines.length) {
      const m = lines[j].match(ATTRIBUTE_BULLET_LINE);
      if (!m || !ATTRIBUTE_BULLET_LABELS.has(m[1].trim().toLowerCase())) break;
      run.push(m[2].trim());
      j++;
    }
    if (run.length >= 2) {
      const paragraph = run.map((s) => (/[।.!?]$/.test(s) ? s : `${s}।`)).join(" ");

      // Look back past any blank lines for a short "header:" line that only
      // exists to introduce this bullet run (e.g. "এর বৈশিষ্ট্য:") — drop it
      // too, since the flowing paragraph below now speaks for itself and a
      // leftover "here are the details:" lead-in still looks like a
      // formatted spec sheet.
      let k = output.length - 1;
      while (k >= 0 && output[k].trim() === "") k--;
      if (
        k >= 0 &&
        /[:：]\s*$/.test(output[k]) &&
        output[k].trim().length <= 40 &&
        !ATTRIBUTE_BULLET_LINE.test(output[k])
      ) {
        output.length = k;
      }

      output.push(paragraph);
      i = j;
    } else {
      output.push(lines[i]);
      i++;
    }
  }
  return output.join("\n");
}

function normalizeProductName(s: string): string {
  return s
    .replace(/\(.*?\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ঀ-৿]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Bug found 2026-08-20: every digit-matching regex in this file's safety
// nets ([\d,]+) is ASCII-only, so a price written in Bengali numerals
// (০-৯) never matched at all — direct-tested with Node ("₹৫০" against
// PRODUCT_LISTING_LINE returns null). Since the AI is instructed to reply
// in Bengali (digits included) when the customer writes in Bengali, and
// every real screenshot reviewed this session shows exactly that, these
// safety nets were silently inert on a large share of real replies. This
// converts a throwaway COPY of text to ASCII digits before matching —
// callers keep using the ORIGINAL text for anything the customer sees.
const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";
function normalizeDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String(BENGALI_DIGITS.indexOf(d)));
}

// Every number (as a plain float, commas stripped) found anywhere in a
// product's raw price field — free-text, so it may read "150", "₹150",
// "5 pcs - ৳250", or even "500gm - ₹150, 1kg - ₹280" for a product that
// covers a couple of sizes in one field without separate variant rows.
// Collecting ALL numbers (not just the first) means a genuinely multi-price
// field still validates correctly against whichever figure the model quotes.
function extractRealPriceNumbers(priceRaw: string | null | undefined): Set<number> {
  if (!priceRaw) return new Set();
  const matches = normalizeDigits(priceRaw).match(/[\d,]+(?:\.\d+)?/g) || [];
  return new Set(
    matches.map((m) => parseFloat(m.replace(/,/g, ""))).filter((n) => !Number.isNaN(n))
  );
}

// `variants` and `category` are optional — populated only when this product
// came from banglardoi.com's live structured catalog (see
// fetchBanglarDoiFullCatalog in lib/banglardoi.ts, wired in by
// app/api/whatsapp/webhook/route.ts, added 2026-08-20). A product sourced
// from the local Product table (the pre-existing fallback) simply omits
// them — every existing call site keeps working unchanged. When present,
// `variants` is the REAL "2 Pc — ₹100 / 5 Pieces — ₹250"-style pack list,
// which lets stripHallucinatedProductListings below do an EXACT
// quantity-to-price check instead of the older "is this number present
// somewhere" heuristic.
export type CatalogProduct = {
  name: string;
  price?: string | null;
  description?: string | null;
  category?: string | null;
  variants?: { label: string; price: string; minOrderQty: number }[];
  // "What's inside this pack" — only present for a Combo/Gift Box product
  // (banglardoi-app's ProductBundleItem, added 2026-08-20). Only ever set
  // when the live banglardoi.com catalog was used (a local-DB-only
  // fallback never sets this) — see buildSystemPrompt's bundleNote below
  // for how the AI is told about it.
  bundleItems?: { quantity: number; name: string; variantLabel?: string | null }[];
};

// Pulls a "Minimum Order: N piece(s)" style line out of a product's
// description, if present, so it can be surfaced in the compact catalog list
// below WITHOUT depending on RAG chunk retrieval picking the right product's
// full description text for a given message — that retrieval is inherently
// fuzzy, and this is exactly the kind of hard constraint (customer typed a
// quantity below the real minimum) that must never be missed. Matches
// "Minimum Order: 5 pieces", "Minimum Order: 5 pcs", "min order 5 pcs", etc.
function extractMinOrder(description?: string | null): string | null {
  if (!description) return null;
  const m = description.match(/minimum\s*order\s*[:\-]?\s*(\d+)\s*(pieces?|pcs?)/i);
  return m ? m[1] : null;
}

// Product-listing bullet line, e.g. "*SORBHAJA* — 5 pcs — ₹250" or
// "* Baked Rosogolla — 1 kg — ₹350" — deliberately requires an actual price
// figure, so ordinary bulleted text (FAQs, policy notes) is never touched by
// this filter, only genuine "here's a list of products with prices" lines.
// Group 1 is the product name, group 2 is whatever sits between the name and
// the price (usually a quantity/pack phrase like "5 pcs" or "৫ পিস" — used by
// the quantity-mismatch check below), group 3 is the quoted price digits.
// Matched against a digit-normalized COPY of the line (see stripHallucinated-
// ProductListings) so this also engages on Bengali-numeral prices.
const PRODUCT_LISTING_LINE = /^[•*\-]\s*\*?([^*\n—–-]{2,50}?)\*?\s*[—–-]\s*(.*?)[₹৳]\s*([\d,]+(?:\.\d+)?)/;

// A quantity phrase stating MORE than one piece — "5 pcs", "10 pieces",
// "৫ পিস", "৩টি" — used only to catch the specific bug below (a per-piece
// price shown next to a multi-piece quantity label). Deliberately limited to
// piece/count units, never weight (kg/gm), since a per-kg vs per-gm mix-up
// isn't something this heuristic can safely reason about. Uses a negative
// lookahead instead of \b after the unit word — JS's \b only treats ASCII
// [A-Za-z0-9_] as "word" characters, so it fails to find a boundary right
// after a Bengali-script word like "পিস" (confirmed by direct testing: \b
// silently never matched there at all, which would have made this whole
// check a no-op on the Bengali-unit case it's specifically meant to catch).
const MULTI_PIECE_QTY = /(\d+)\s*(?:pcs?|pieces?|পিস|টি|টা)(?![a-zA-Zঀ-৿])/i;

// Parses a leading count + unit out of a piece-count phrase — "5 pcs",
// "৫ পিস", "2 Pc" (a real variant label from banglardoi.com), "1 piece" —
// into a plain number, or null if the phrase isn't piece-counted at all
// (e.g. a weight like "500 gm"/"1 kg", which this deliberately leaves alone
// — see findMatchingVariant below). Used to match a listing line's stated
// quantity against a REAL variant label when live catalog data is
// available (CatalogProduct.variants), for an exact rather than heuristic
// quantity-to-price check.
function parsePieceCount(phrase: string): number | null {
  const m = normalizeDigits(phrase).match(/(\d+)\s*(?:pcs?|pieces?|পিস|টি|টা)(?![a-zA-Zঀ-৿])/i);
  return m ? parseInt(m[1], 10) : null;
}

// Finds the real variant whose label states the SAME piece count as the
// listing line's quantity phrase — e.g. line phrase "৫ পিস" (5) matches a
// real variant labeled "5 Pieces" or "5 Pc". Returns undefined (not found —
// caller should fall back to the older heuristic check) rather than a false
// match when the line's phrase isn't a clear piece-count at all (weight-
// based lines are intentionally left to the existing checks).
function findMatchingVariant(
  qtyPhrase: string,
  variants: { label: string; price: string; minOrderQty: number }[]
): { label: string; price: string; minOrderQty: number } | undefined {
  const lineQty = parsePieceCount(qtyPhrase);
  if (lineQty == null) return undefined;
  return variants.find((v) => parsePieceCount(v.label) === lineQty);
}

// Third deterministic safety net (same family as applyTerminologySwaps and
// flattenAttributeBulletLines above) — added after a real incident where,
// asked "any other best sweets you have?", the model listed real catalog
// items alongside entirely invented ones (a plain "Rosogolla" and "Chhanar
// Payesh" this business doesn't actually sell, at made-up prices), even
// though the system prompt already said not to invent facts — same lesson
// as always: that instruction is a hint, not a guarantee. The hard catalog
// list injected into the system prompt (see buildSystemPrompt's catalogNote)
// is the first line of defense; this is the actual guarantee — any listed-
// product line is checked TWICE: the name must match a REAL product in this
// organization's catalog (by near-exact name, after normalizing), AND the
// quoted price must match a real number found in that same product's price
// field. A real product name paired with a WRONG or made-up price is exactly
// as dangerous as an invented product — a real incident had the model write
// "Baked Rosogolla — 1 kg — ₹350" (the real product's actual price is ₹150;
// ₹350 belonged to a completely different product, 1kg Doi), which the old
// name-only check would have let straight through since "Baked Rosogolla" is
// a genuine catalog item. Any line failing either check is removed from what
// the customer actually receives, regardless of what the model wrote.
// Deliberately strict (name: exact match only, never "contains"; price: must
// be a real number on file, never "close enough") — a fuzzy/substring name
// match would let a fake "Rosogolla" line slip through just because it's a
// substring of the real "Baked Rosogolla". Trade-off: a real product whose
// name the model paraphrases slightly, or whose price field doesn't cleanly
// contain the exact figure quoted, may get dropped too (a false negative,
// just a missing line) — much safer than the alternative (a fake product or
// price reaching a real customer).
export function stripHallucinatedProductListings(text: string, catalogProducts: CatalogProduct[]): string {
  if (!text || catalogProducts.length === 0) return text;
  const realProductsByName = new Map<string, CatalogProduct>();
  for (const p of catalogProducts) {
    const key = normalizeProductName(p.name);
    if (key) realProductsByName.set(key, p);
  }

  const lines = text.split("\n");
  const output: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const run: { line: string; keep: boolean }[] = [];
    let j = i;
    while (j < lines.length) {
      // Match against a digit-normalized COPY — lines[j] itself (pushed to
      // `run` below) keeps its original Bengali/ASCII digits unchanged for
      // the customer.
      const m = normalizeDigits(lines[j]).match(PRODUCT_LISTING_LINE);
      if (!m) break;
      const real = realProductsByName.get(normalizeProductName(m[1]));
      let keep = false;
      if (real) {
        const quoted = parseFloat(m[3].replace(/,/g, ""));
        const realNumbers = extractRealPriceNumbers(real.price);
        // No parseable price on file at all → the quoted number can't be
        // verified either way, so don't trust it — same "drop rather than
        // risk it" call as an unrecognized product name.
        keep = realNumbers.size > 0 && realNumbers.has(quoted);

        // Real incident (2026-08-20, owner's own WhatsApp screenshot):
        // "SORBHAJA – 5 pcs – ₹50" — ₹50 genuinely IS Sorbhaja's real price
        // on file, so the check above lets it through, but ₹50 is its
        // PER-PIECE price, not a 5-piece total — the customer had already
        // corrected the AI on this exact mistake once earlier in the same
        // conversation, and it repeated it anyway. The check above only
        // confirms the quoted number exists somewhere in the price field;
        // it can't, on its own, confirm it's the RIGHT number for the
        // STATED quantity. Two ways to catch that, tried in order:
        //
        // 1) EXACT check, when live variant data is available (added
        // 2026-08-20, same day as the incident above — see
        // fetchBanglarDoiFullCatalog in lib/banglardoi.ts): look up the
        // REAL variant matching this line's stated piece count and require
        // the quoted price to equal that variant's real price exactly, no
        // guessing. This is strictly more correct than the heuristic below
        // wherever it can apply — e.g. it correctly ALLOWS "5 pcs – ₹250"
        // once ₹250 really is Sorbhaja's real 5-piece bundle price, which
        // the old heuristic (any product with only one price on file) can't
        // distinguish from the bug case.
        if (real.variants && real.variants.length > 0) {
          const matchedVariant = findMatchingVariant(m[2], real.variants);
          if (matchedVariant) {
            const variantPrice = parseFloat(normalizeDigits(matchedVariant.price).replace(/[₹৳,\s]/g, ""));
            keep = !Number.isNaN(variantPrice) && quoted === variantPrice;
          }
          // No confident variant match (e.g. a weight-based line like "500
          // gm", which this exact check deliberately doesn't attempt) —
          // fall through to whatever `keep` the flat number-exists check
          // above already produced.
        } else if (keep && realNumbers.size === 1) {
          // 2) Heuristic fallback, for products with no live variant data
          // (local-DB-only products): the product has only ONE price figure
          // on file at all (no bundle/tier pricing to fall back on), the
          // line states a quantity of MORE than one piece, and the quoted
          // price is exactly that single on-file figure, unmultiplied —
          // i.e. almost certainly a per-piece price mislabeled at a bulk
          // quantity. Same "drop rather than risk it" stance as everywhere
          // else in this function.
          const qtyMatch = m[2].match(MULTI_PIECE_QTY);
          if (qtyMatch && parseInt(qtyMatch[1], 10) > 1) {
            keep = false;
          }
        }
      }
      run.push({ line: lines[j], keep });
      j++;
    }
    if (run.length > 0) {
      const survivors = run.filter((r) => r.keep).map((r) => r.line);
      if (survivors.length === 0) {
        // Every line in this listing was fake — also drop a short preceding
        // "here are some options:" header, same look-back idea as
        // flattenAttributeBulletLines above, so nothing dangles with an
        // empty list underneath it.
        let k = output.length - 1;
        while (k >= 0 && output[k].trim() === "") k--;
        if (k >= 0 && /:\s*$/.test(output[k]) && output[k].trim().length <= 120) {
          output.length = k;
        }
      } else {
        output.push(...survivors);
      }
      i = j;
    } else {
      output.push(lines[i]);
      i++;
    }
  }
  return output.join("\n");
}

// Word-splitter local to this check — deliberately separate from
// stripHallucinatedProductListings' normalizeProductName above (that one is
// for exact-name lookup in a Map; this one is for "does this text contain
// these words at all", so it keeps every word rather than normalizing to a
// single key). Same Bengali-aware character class already proven correct in
// the webhook's own extractWords (route.ts) — split on anything that isn't
// a-z/0-9/Bengali script, lowercase first so case never matters.
function extractWordsForClaimCheck(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9ঀ-৿]+/i).filter((w) => w.length > 0);
}

// True when every word of `needle` appears as a whole word somewhere in
// `haystack` — word-based rather than a raw substring check, so a short
// name like "Doi" doesn't false-positive-match as a substring of an
// unrelated longer word. Requires ALL of needle's words to be present
// (order/adjacency not required) since product and Event names are usually
// short enough that this is a reliable enough signal without being overly
// strict.
function textContainsAsWords(haystack: string, needle: string): boolean {
  const needleWords = extractWordsForClaimCheck(needle).filter((w) => w.length >= 2);
  if (needleWords.length === 0) return false;
  const haystackWords = new Set(extractWordsForClaimCheck(haystack));
  return needleWords.every((w) => haystackWords.has(w));
}

// Fourth deterministic safety net (same family as stripHallucinatedProductListings
// above and validateBusinessClaims in lib/business-rules.ts) — added after a
// real incident where the AI, asked "etaiki janmastami r special?" about a
// product photo (Kheer Gulab Jamun) just sent, confirmed it as a Janmashtami
// special even though that product is never mentioned anywhere in the real
// Janmashtami Event's own text (Taal Bora, Dudh Puli, Malpoa, Patisapta are
// the actual specials). A product↔campaign/event ASSOCIATION claim was being
// trusted on the model's own say-so, with nothing checking it — unlike a ₹
// number (validateBusinessClaims) or a catalog listing (the check above).
//
// Deliberately blunt, same "drop rather than risk it" trade-off already
// accepted above: ANY sentence naming both a real catalog product and a real
// Event/campaign title is treated as an association claim, regardless of the
// exact linking wording used (English "special for", Bengali "জন্য বিশেষ",
// or no explicit linking word at all) — reliably parsing the specific claim
// verb across Bengali/English/Banglish is far less certain than just
// checking whether the two are named in the same sentence. If the named
// product isn't literally named anywhere in that Event's own text, the
// sentence is dropped rather than risk a false association reaching the
// customer. Trade-off: a sentence that legitimately mentions both a product
// and an unrelated event in passing, with no real claim intended, can get
// dropped too — a missing sentence, not a wrong fact, the safer direction to
// err in (same call already made for the checks above).
export function validateEntityAssociationClaims(
  text: string,
  catalogProducts: CatalogProduct[],
  events: { title: string; fullText: string }[]
): string {
  if (!text || catalogProducts.length === 0 || events.length === 0) return text;

  const productNames = catalogProducts.map((p) => p.name).filter(Boolean);

  // Split into sentences on Bengali/English sentence-enders, KEEPING the
  // separators (odd indices) so the rejoin reproduces the original text
  // byte-for-byte except for whatever sentence got dropped.
  const sentenceParts = text.split(/([।.!?\n]+)/);

  const output: string[] = [];
  for (let i = 0; i < sentenceParts.length; i += 2) {
    const sentence = sentenceParts[i] ?? "";
    const trailing = sentenceParts[i + 1] ?? "";
    if (!sentence.trim()) {
      output.push(sentence + trailing);
      continue;
    }

    const mentionedProduct = productNames.find((name) => textContainsAsWords(sentence, name));
    const mentionedEvent = mentionedProduct
      ? events.find((e) => textContainsAsWords(sentence, e.title))
      : undefined;

    if (mentionedProduct && mentionedEvent) {
      const associated = textContainsAsWords(mentionedEvent.fullText, mentionedProduct);
      if (!associated) {
        continue; // drop this sentence only — keep the rest of the reply intact
      }
    }
    output.push(sentence + trailing);
  }
  return output.join("");
}

function todayInIndia(): string {
  // en-CA locale formats as YYYY-MM-DD, which doubles as a clean ISO date string.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function buildSystemPrompt(
  profile: AgentProfileInput | undefined,
  contextBlock: string,
  hasTools: boolean,
  photoNote: string = "",
  catalogProducts: CatalogProduct[] = [],
  businessRulesNote: string | null = null
): string {
  const businessName = profile?.businessName?.trim() || "the business";
  const description = profile?.businessDescription?.trim();
  const coreIdentity = profile?.coreIdentity?.trim();
  const tone = TONE_TEXT[profile?.tone ?? "friendly"] ?? TONE_TEXT.friendly;
  const language = LANGUAGE_TEXT[profile?.languageStyle ?? "mixed"] ?? LANGUAGE_TEXT.mixed;
  const customInstructions = profile?.customInstructions?.trim();
  const brandLanguageNote = buildBrandLanguageNote(profile?.brandLanguage);

  const toolsNote = hasTools
    ? `\n\nYou have tools available for certain actions (e.g. saving a customer's address, or setting a follow-up reminder). Use a tool naturally when the conversation calls for it — don't ask for permission first, just do it, then confirm what you did in your reply.`
    : "";

  const customInstructionsNote = customInstructions
    ? `\n\nAdditional rules from the business owner — always follow these:\n${customInstructions}`
    : "";

  const photoInstructionNote = photoNote ? `\n\n${photoNote}` : "";

  // Business Rule Engine note (lib/business-rules.ts) — the ONLY source of
  // truth for delivery fee/minimum order/campaign numbers. Placed ahead of
  // catalogNote and brandLanguageNote to match the stated priority
  // hierarchy: Hard Business Rules + Live/current data + Active campaign
  // rules come before Product knowledge and Brand language/style. Computed
  // by the caller (route.ts) via buildBusinessRulesNote() and passed in here
  // — buildSystemPrompt itself stays synchronous, same pattern already used
  // for photoNote/catalogProducts below.
  const businessRulesNoteText = businessRulesNote ? `\n\n${businessRulesNote}` : "";

  // Hard grounding list — a general "never invent facts" instruction already
  // existed below and still wasn't enough on its own by itself (real
  // incident #1: asked for "other sweets", the model padded the list with
  // well-known Bengali sweet names — plain Rosogolla, Chhanar Payesh — that
  // this specific business doesn't actually sell, with made-up prices; real
  // incident #2: the model paired a REAL product's name with a price that
  // actually belonged to a completely different real product — "Baked
  // Rosogolla" at ₹350/1kg, when the real Baked Rosogolla is ₹150 and ₹350
  // was a different item's 1kg Doi price). Giving the model the exact,
  // complete, closed list of real product names AND their real prices is a
  // much stronger and more checkable constraint than an abstract
  // instruction. Capped defensively — a catalog large enough to blow past
  // this either way needs the deterministic stripHallucinatedProductListings
  // backstop (below in this file), not a longer and longer prompt.
  const CATALOG_NAME_CAP = 150;
  const catalogNote =
    catalogProducts.length > 0
      ? `\n\nThe COMPLETE, EXACT list of every product this business actually sells, with its real price and (where set) its real minimum order quantity — nothing else exists, even a well-known item you'd normally expect a shop like this to carry, and no product's real price or minimum is ever anything other than what's listed here: ${catalogProducts
          .slice(0, CATALOG_NAME_CAP)
          .map((p) => {
            // Live variant data (from banglardoi.com, see CatalogProduct's
            // own comment) is the real, structured "2 Pc — ₹100 / 5 Pieces
            // — ₹250"-style pack list — prefer it outright over the older
            // regex-scraped-from-description min-order guess below, since
            // it's exact rather than inferred.
            if (p.variants && p.variants.length > 0) {
              const variantText = p.variants
                .map((v) => `${v.label}: ${v.price}${v.minOrderQty > 1 ? ` (min order ${v.minOrderQty})` : ""}`)
                .join(", ");
              return `${p.name} [${variantText}]`;
            }
            const minOrder = extractMinOrder(p.description);
            return `${p.name}${p.price ? ` (${p.price})` : ""}${minOrder ? ` [min order: ${minOrder} pcs]` : ""}`;
          })
          .join(", ")}${
          catalogProducts.length > CATALOG_NAME_CAP ? ", …" : ""
        }. NEVER mention, list, suggest, or imply the existence of a product not in this exact list, and NEVER quote a price for a listed product other than its real price shown here — never borrow, average, or guess a price from a different product. If a customer asks about something not on this list, or a price you're not sure of, say honestly that you don't carry it or aren't certain and will check, instead of guessing or padding out an answer to sound more helpful. When a product's entry above shows several bracketed options like "[2 Pc: ₹100, 5 Pieces: ₹250]", each is its OWN real price for that exact pack — never compute or guess a price for a quantity that isn't listed by multiplying another one yourself, and never state one bracketed option's price as if it were a different one's.`
      : "";

  // Category info — only present when the live banglardoi.com catalog was
  // used (see CatalogProduct's own comment; a local-DB-only fallback never
  // sets `category`). Added 2026-08-20 alongside the live-catalog wiring so
  // the AI can proactively point a browsing/unsure customer at a category —
  // e.g. Gift Box or Combo — instead of only ever naming individual items
  // one at a time.
  const categoryNames = Array.from(
    new Set(catalogProducts.map((p) => p.category).filter((c): c is string => Boolean(c && c.trim())))
  );
  const categoriesNote =
    categoryNames.length > 0
      ? `\n\nThis business organizes its products into these categories: ${categoryNames.join(
          ", "
        )}. When a customer seems unsure what to order, is just browsing, or asks for a gift or a combo/festival pack, it's natural to mention a relevant category (e.g. suggest looking at the Gift Box or Combo options) rather than only ever listing individual items — but only suggest a category that's actually in this list.`
      : "";

  // Combo/Gift Box contents — only present for a product whose `bundleItems`
  // was set by the admin (banglardoi-app's ProductBundleItem; see
  // CatalogProduct's own comment). Added 2026-08-20 alongside the admin UI
  // to build these packs, at the owner's own request: previously there was
  // no way for the AI to know what was actually inside a Combo or Gift Box,
  // so a customer asking "combo-te ki ki ache?" either got no real answer
  // or, worse, an invented one.
  const bundleProducts = catalogProducts.filter((p) => p.bundleItems && p.bundleItems.length > 0);
  const bundleNote =
    bundleProducts.length > 0
      ? `\n\nThe exact, real contents of these Combo/Gift Box packs (only mention what's listed here — never guess or invent a pack's contents): ${bundleProducts
          .map(
            (p) =>
              `${p.name} contains [${p
                .bundleItems!.map((b) => `${b.quantity} × ${b.name}${b.variantLabel ? ` (${b.variantLabel})` : ""}`)
                .join(", ")}]`
          )
          .join("; ")}.`
      : "";

  // Added after a real incident: "Baked Rosogolla" is priced as "৳30/pc (min
  // order 5 pcs = ৳150)" — a customer asked to confirm "1 pc ৳150?" and the
  // model answered "১ পিসের দাম ৳150" (the price of 1 piece is ৳150),
  // treating the min-order BUNDLE total as if it were the single-piece rate.
  // ৳150 is a real number that genuinely appears in this product's price
  // field, so it isn't a hallucination in the usual sense (the number is
  // real) — the mistake is pairing a real number with the WRONG quantity.
  // This is a case the deterministic filters in this file structurally
  // cannot catch: stripHallucinatedProductListings only checks that a
  // quoted number appears somewhere in the price string, it has no idea
  // which quantity that number is supposed to describe, and this specific
  // reply was single-product prose anyway, a format that filter doesn't
  // even scan. So unlike the name/price-existence checks above, correctness
  // here rests entirely on the model reading and reasoning about the price
  // string correctly — there is no code-level backstop for this one.
  // Spelling the expected convention out explicitly, with a worked example,
  // is the only lever available.
  const priceFormatNote =
    catalogProducts.length > 0
      ? `\n\nSome prices above are written as "₹X/pc (min order N pcs = ₹Y)" — X is the price of ONE single piece, N is the minimum quantity that must be ordered, and Y is simply X multiplied by N (the total cost of ordering the minimum quantity), not a separate or different price. If a customer asks the price of a single piece, always answer with X, never Y. Only mention Y when you're stating the total cost of the minimum order (e.g. "৫ পিস অর্ডার করলে মোট ৳150"), and always make clear which quantity a price refers to — never state a multi-piece total as if it were a single piece's price. Example: for "₹30/pc (min order 5 pcs = ₹150)", "1 pc price?" → "৳30 প্রতি পিস (সর্বনিম্ন অর্ডার ৫ পিস, অর্থাৎ মোট ৳150)" — never "১ পিসের দাম ৳150". Some products instead show this as two separate lines, e.g. "Price: ₹30 per piece" and "Minimum Order: 5 pieces" — treat that exactly the same way, computing the total yourself as price × minimum when needed.

MINIMUM ORDER IS A HARD RULE, ALWAYS CHECK IT — this applies to every single reply about a quantity, not just when finalizing an order. Whenever a customer states or implies a quantity for a specific product (even in a first "here's what I'd like" message, before anything is confirmed), check that product's info for a "Minimum Order" line FIRST, before calculating or quoting any total. If their quantity is below that minimum: do NOT calculate a total for it, do NOT treat it as accepted, and do NOT proceed toward confirming an address/order — instead, tell them the minimum plainly and ask if they'd like to order that many instead. Only calculate a total and move toward confirming once the quantity meets or exceeds the minimum.

If a customer asks for a size/weight/quantity that isn't sold as its own pack (e.g. they ask for 1 kg but only 250 gm and 500 gm packs are listed), don't just say it's unavailable and stop there — check whether an exact multiple of a real listed pack reaches what they asked for (e.g. two 500 gm packs = 1 kg), and if so, proactively suggest that combination, computing the total by multiplying that exact pack's real listed price (never inventing or guessing a new price, and never a fractional/partial pack) — e.g. "১ kg প্যাকেজ নেই, তবে ৫০০ gm-এর ২টা প্যাকেজ নিলে ১ kg হয়ে যাবে, মোট হবে ₹1000।" If no clean multiple lands exactly on what they asked for, say so plainly and offer the closest real pack sizes instead of forcing an odd combination.`
      : "";

  // Core AI Identity (set in Agent Studio → Profile, top of the page) is a
  // free-text persona/voice/judgment paragraph the owner writes themselves.
  // When present it REPLACES this default one-liner as the opening frame —
  // a rich, coherent identity paragraph shapes tone and judgment far more
  // consistently than a pile of separate small rules ever can. A short
  // technical anchor line is still appended so the model always knows it's
  // actually the WhatsApp assistant for this specific business.
  const openingLine = coreIdentity
    ? `${coreIdentity}\n\nYou represent ${businessName} on WhatsApp${
        description ? ` (${description})` : ""
      } and answer questions from customers and staff.`
    : `You are the WhatsApp assistant for ${businessName}${description ? `, ${description}` : ""}. You answer questions from customers and staff.`;

  return `${openingLine}

Tone: be ${tone}. ${language}

Language quality matters a lot here — a wrong or made-up word, or an awkward/ungrammatical sentence, looks unprofessional to a real customer. Keep sentences short and simple rather than reaching for a fancier word or phrase you're unsure of. When writing in Bengali specifically, use natural verb conjugation and word order — never construct a sentence by translating English word-for-word; if a sentence would come out sounding unnatural or grammatically off, simplify it rather than sending it as-is. Never invent or switch in a word from a language other than Bengali/English (no stray Cyrillic, Hindi, or anything else) — if you don't know the natural Bengali word for something, say it in English instead of guessing. Some concrete examples of the literal, "AI-translated" phrasing to avoid: "ক্রিম (সোর)" (say "দুধের সর"), "চিনির সিরাপ" (say "চিনির রস"), an unnecessary comparison like "বিস্কিটের মতো ক্রিস্পি" (just say "হালকা খাস্তা"), "এর মিষ্টতা খুবই সঠিক" (say "পরিমিত মিষ্টি"), and the misspelling "ক্রিমী" (correct spelling is "ক্রিমি").

Write like a real, attentive member of the team — natural and warm, never stiff or robotic, and don't narrate that you're following instructions. If a customer directly and sincerely asks whether they're chatting with a bot/AI or a human, answer honestly — don't deny it or lie about it.

Describing a SINGLE product is not the same as listing MULTIPLE products — don't turn one item's own attributes (what it is, how it tastes, pack size, price) into a bulleted spec sheet; that reads like a printed label, not a person answering a question. Write 2-4 short, connected sentences the way a staff member would actually describe it out loud, and only mention the pack size/price in that natural phrasing (e.g. "৫ পিস – ₹২৫০ প্যাকেজ" as sold, not a computed per-piece rate like "₹50 প্রতি পিস" unless the customer specifically asks for a per-piece price). Reserve the bulleted "one item per line" format below strictly for when you're actually listing several DIFFERENT products in the same reply.

Never state how a product is physically made, layered, or assembled (e.g. "সরের স্তরের মাঝে মালাইয়ের পুর") unless that exact detail is literally present in the reference material below — this is exactly the kind of specific factual claim you must never invent, even if it sounds plausible.

If it's natural to ask whether the customer wants to order or knows anything else, keep that as its own short, freshly-worded line — never glue a fixed template line like "আপনি কি অর্ডার দিতে চান বা আরও কিছু জানতে চান?" onto the end of every product description; vary it, and skip it entirely when it doesn't fit the flow of the conversation.

Behave like a real, attentive salesperson working one sale at a time — if the customer is actively discussing, asking about, or in the middle of buying a specific product (its price, quantity, variant, or they've started giving delivery details), stay focused and help them finish that — don't proactively bring up, describe, or send a different product until this one is settled (an order confirmed, or the customer clearly moves on themselves). Only pivot to another product when the customer asks about something else, says they're done, or there's a natural pause with nothing left to settle on the current item.

Formatting rules — this is WhatsApp, not a document. WhatsApp does NOT render Markdown headers or list syntax — if you write "###" or "##" it shows up as literal hash symbols, and a leading "- " shows up as a literal dash. NEVER use "#", "##", "###", or a leading "-" or "*" for list items. For emphasis use single asterisks like *this* (WhatsApp renders that as bold) — never double asterisks. When listing multiple DIFFERENT products or items together, put each one on its own line and use the bullet character "•" (not a hyphen) if you need a marker, e.g.:
*SORBHAJA* — 5 pcs — ₹250
*Laal Kheer Doi* — 500 gm — ₹300
Keep it looking like a real WhatsApp message a person would type, not a formatted report. The price is NOT optional in that line, even for a general "what do you have" / "ki ki product ache" question where the customer didn't ask about price specifically — a listing reply that shows only the pack size/quantity (e.g. "SORBHAJA - 5 pcs") without a ₹ price for each item is wrong and incomplete. Always pull the real price for each item from the catalog list below and put it on the same line.

Today's date is ${todayInIndia()} (India, Asia/Kolkata timezone). Use this to resolve any relative dates the customer mentions (tomorrow, next Monday, in 3 days, etc.) into an exact date.

Answer factual questions ONLY using the reference material below. If the answer is not contained in the material, say clearly that you don't know and suggest they ask the business directly — never invent facts, prices, or details that aren't in the material. Always mention which source(s) (by title) you used to answer factual questions. If a source titled "EXACT CURRENT INFO — [product name]" is present, that is the ground-truth, freshly-fetched record for the product this conversation is currently about — trust it over any other source AND over anything you yourself said earlier in this same conversation, for that product's price, description, or minimum order quantity. If you notice you stated a different number for this product earlier in the conversation, this fresh record is correct and your earlier statement was wrong — correct yourself plainly rather than repeating the old number for consistency. Other similar-sounding products' details must never be substituted in its place.${toolsNote}${customInstructionsNote}${businessRulesNoteText}${brandLanguageNote}${photoInstructionNote}${catalogNote}${categoriesNote}${bundleNote}${priceFormatNote}

Reference material:
${contextBlock}`;
}

// Vision.md principle: the AI must say "I don't know" rather than invent facts —
// the system prompt above enforces that explicitly.
export async function askAI(
  question: string,
  sources: SourceChunk[],
  profile?: AgentProfileInput,
  history: ChatHistoryMessage[] = [],
  photoNote: string = "",
  catalogProducts: CatalogProduct[] = [],
  businessRulesNote: string | null = null
): Promise<AiCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const contextBlock = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(profile, contextBlock, false, photoNote, catalogProducts, businessRulesNote);

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: question },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI chat completion failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return { answer: (data.choices[0].message.content as string) ?? "", usage: extractUsage(data) };
}

// ---- Function calling (agentic skills) ----
// Lets the AI take real actions mid-conversation (save an address, set a
// reminder) instead of only answering questions. The caller supplies which
// tools are currently enabled and an `executeTool` callback that actually
// performs the action (writing to the real database on WhatsApp, or just
// simulating the result in the Test Sandbox).

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

export const SAVE_ADDRESS_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "save_customer_address",
    description:
      "Save or update the customer's delivery/home address on file. Use this whenever the customer shares their address, even a partial one — but a delivery address isn't complete until it has a house/street/flat detail AND a 6-digit PIN code (delivery fee, COD availability, and delivery time all depend on the PIN code). If the customer only gives an area/locality name (e.g. 'Sonarpur') with no PIN code and no street-level detail, still call this tool to save what they gave, but your reply must explicitly ask for the missing PIN code (and street/house detail if that's also missing) before treating the address as ready to deliver to or confirming any order against it.",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "The customer's full address, as they gave it — even if incomplete." },
        pincode: {
          type: "string",
          description:
            "The customer's 6-digit PIN code, if they gave one (even if the rest of the address is on file already or still incomplete) — extract it separately here even though it also appears inside `address`, so it can be used to look up delivery fee/minimum order for their area.",
        },
      },
      required: ["address"],
    },
  },
};

export const SET_REMINDER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "set_reminder",
    description:
      "Create a follow-up reminder for staff about this customer, due on a specific date. Use this when the customer asks to be reminded, followed up with, or contacted again about something.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short description of what to follow up about." },
        dueDate: {
          type: "string",
          description: "The follow-up date in YYYY-MM-DD format, resolved from today's date.",
        },
      },
      required: ["title", "dueDate"],
    },
  },
};

export const RECORD_INTEREST_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "record_product_interest",
    description:
      "Note that this customer is interested in a specific product from the catalog, so staff can follow up later. Use this when the customer asks about, praises, or seems interested in buying a particular product.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description: "The product name, as close as possible to how it's listed in the catalog.",
        },
        note: {
          type: "string",
          description: "Optional short context, e.g. 'asked about bulk pricing' or 'wants it for a wedding'.",
        },
      },
      required: ["productName"],
    },
  },
};

export const PLACE_ORDER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "record_order",
    description:
      "Record a new order for the customer. Only use this AFTER you've read the items/quantities back to the customer and they've confirmed it's correct — don't call this on the first mention of wanting to buy something, and don't call it more than once for the same order. IMPORTANT: before confirming, check the reference material for that product for any minimum order quantity or minimum pack size (e.g. 'min order 5 pcs'). If the customer's requested quantity is below that minimum, do NOT call this tool yet — tell them the minimum first and ask if they'd like to adjust the quantity, and never silently change their requested quantity without saying so out loud. ALSO IMPORTANT, if this is a delivery order (not in-store pickup): do NOT call this tool until the delivery address includes a house/street/flat-level detail AND a 6-digit PIN code — an area/locality name alone (e.g. just 'Sonarpur') is not a complete address. If the PIN code or street detail is still missing, ask for it and wait for the answer before recording the order; do not confirm or finalize an order against an incomplete address. FINALLY: only include items the customer is asking about in THIS current, still-open, not-yet-confirmed request. If an earlier message in this conversation already resulted in a separate confirmed/recorded order, do NOT pull those old items back into a new order's total — that double-counts them. Only merge multiple items into one order when the customer is clearly still building the same single unconfirmed cart across consecutive messages (e.g. 'I want X' then 'also add Y' before either was confirmed).",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "string",
          description: "The confirmed items and quantities, as a short readable list, e.g. '2kg Mishti Doi, 1kg Ghee'.",
        },
        deliveryAddress: {
          type: "string",
          description:
            "Full delivery address, only if the customer wants delivery — must include house/street/flat detail AND a 6-digit PIN code, not just an area/locality name. Leave out entirely if they're picking up in-store.",
        },
        note: {
          type: "string",
          description: "Any other instruction from the customer, e.g. preferred delivery time.",
        },
        estimatedTotal: {
          type: "number",
          description:
            "Your best-effort total ₹ amount for this order, computed from the real catalog prices/quantities you already have (e.g. 2 × ₹180 + 1 × ₹110 = ₹470). Used only to check delivery-zone minimum-order and delivery-fee rules — not treated as the final bill, which staff confirm separately. Always include this when you can compute it; if you genuinely can't (e.g. price wasn't confirmed), omit it rather than guessing.",
        },
      },
      required: ["items"],
    },
  },
};

// Always included, regardless of Agent Studio skill toggles — unlike the other
// tools this isn't an opt-in "feature", it's a safety net every business wants:
// when the AI genuinely can't help, it should say so and step aside rather than
// loop or bluff. See webhook route.ts / test route.ts where `tools` is built.
export const REQUEST_HANDOFF_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "request_human_handoff",
    description:
      "Use this when you genuinely cannot help the customer — you don't know the answer even after checking the knowledge base, the customer explicitly asks to speak to a real person/staff/owner, or the customer seems frustrated or upset with automated replies. This pauses your automatic replies so a staff member can take over personally. Don't overuse it — only call this when a human is genuinely needed, not for every question you're unsure about; try your best to help first.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Brief reason for the handoff so staff know what's needed, e.g. 'Customer wants a refund for a damaged order' or 'Customer explicitly asked to speak to a human'.",
        },
      },
      required: ["reason"],
    },
  },
};

// Always included, same as REQUEST_HANDOFF_TOOL — product photo sharing isn't
// gated by a Skills toggle. This exists because the OLD photo logic only ever
// looked at the CURRENT message's RAG match: a direct "Sorbhaja ache?" matched
// fine, but a context-dependent follow-up like "pic ache?" (no product name
// repeated) scored too weak a match on its own, so no photo was attached —
// even though the model's TEXT reply correctly remembered "Sorbhaja" from
// history. Giving the model an explicit tool lets its own already-working
// context resolution drive the actual send, instead of a second, context-blind
// lookup. See webhook route.ts / test route.ts for how `tools` is built.
export const SEND_PRODUCT_PHOTO_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "send_product_photo",
    description:
      "Send a photo of a specific product to the customer on WhatsApp. Use this whenever the customer asks to see a photo/picture of a product — including when they're asking about a product mentioned earlier in the conversation, not just repeated in their latest message. You DO have this capability; never claim you're unable to share photos or image links — if no photo happens to be saved for that product, the tool result will tell you, and you can say so honestly then.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description:
            "The exact product name being asked about, as close as possible to how it's listed in the catalog — resolve this from conversation context if the customer's latest message didn't repeat the product name.",
        },
      },
      required: ["productName"],
    },
  },
};

// Phase 9 — Banglar Doi-specific live-data lookups (see lib/banglardoi.ts).
// Not gated by a Skills toggle in Agent Studio like the others — included
// only when isBanglarDoiIntegrationEnabled() and organization.vertical ===
// "RETAIL" (see webhook route.ts), since real order/stock lookups only make
// sense for the one retail business this is wired up for today.
export const CHECK_ORDER_STATUS_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "check_order_status",
    description:
      "Look up the customer's own real recent orders — status, items, total, and the latest update — using live store data. Use this whenever the customer asks about an order they placed, e.g. 'where is my order', 'order ekhono ashini', 'ordar ta ki holo', or asks for a delivery update/tracking. Never guess or invent a status — always call this tool first and answer only from what it returns. Takes no input; the lookup uses the customer's own WhatsApp number automatically.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export const CHECK_PRODUCT_STOCK_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "check_product_stock",
    description:
      "Check a specific product's real, live price and stock availability before confidently answering a price or 'is it available' / 'stock ache?' question. This may be more current than what you were taught during onboarding — prefer this tool's answer over your own memory whenever they conflict.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description: "The product name being asked about, as close as possible to how it's listed in the catalog.",
        },
      },
      required: ["productName"],
    },
  },
};

// ---- Teach AI chat (Agent Studio / Training page) ----
// Lets the business owner update the AI's knowledge conversationally instead
// of filling out forms — "Sorbhaja er dam ekhon 260" should just work, the
// same way chatting with Meta's own built-in Business Agent does. See
// app/api/agent/teach/route.ts for how these are wired to real DB writes.
export const UPDATE_PRODUCT_INFO_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "update_product_info",
    description:
      "Update an EXISTING product's price and/or description when the owner tells you new or corrected information about it. Only use this when you're confident which product they mean — match by name as closely as possible. If it's unclear which product they're referring to, or if this sounds like a brand-new fact rather than a correction to a specific product, do NOT call this — ask a clarifying question in your reply instead, or use add_knowledge_note.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description: "The product's name, as close as possible to how the owner referred to it.",
        },
        newPrice: {
          type: "string",
          description:
            "The corrected price, only if the owner mentioned a price change. CRITICAL: capture the FULL pricing detail the owner gave, not just one number — if they mention a per-unit price AND a minimum order quantity or bulk price (e.g. '₹30/pc, min order 5 pcs = ₹150'), put ALL of that in this one string exactly as they said it. Never trim it down to a bare number — losing the minimum-order detail means the AI will later accept orders below the real minimum.",
        },
        newDescription: {
          type: "string",
          description: "The corrected/updated description, only if the owner mentioned a description change.",
        },
      },
      required: ["productName"],
    },
  },
};

export const ADD_KNOWLEDGE_NOTE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "add_knowledge_note",
    description:
      "Save a new FACT, policy, or piece of information the owner just told you, when it is NOT a correction to a specific existing product's price/description AND NOT a rule about how the AI should write or behave (use update_style_rule for that instead). This becomes permanent knowledge the AI uses when answering customers — e.g. store hours, delivery policy, a new offer, or an answer to a common question. It's only reliably found when a customer's question closely matches this topic, so it's the wrong choice for a standing writing/behavior rule that should apply to every reply.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short label for this fact, e.g. 'Weekend closure' or 'COD policy'.",
        },
        content: {
          type: "string",
          description: "The fact/policy itself, written out in full — this is what the AI will read later.",
        },
      },
      required: ["title", "content"],
    },
  },
};

// Added after a real incident: an owner taught a Bengali writing-style
// correction via Teach AI, and the model (reasonably, given the two tools
// that existed at the time) filed it with add_knowledge_note — which only
// resurfaces if a customer's question happens to closely match that note's
// topic via RAG similarity search. A generic style rule almost never wins
// that search against actual product content, so it silently never applied.
// This tool writes to AgentProfile.customInstructions instead, which
// buildSystemPrompt always injects into every single reply, regardless of
// what the customer asked — the correct home for "always follow this" rules.
export const UPDATE_STYLE_RULE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "update_style_rule",
    description:
      "Save a standing rule the AI should ALWAYS follow on every future reply — not just an answer to one factual question. This covers two kinds of rules: (1) HOW the AI should write or behave — tone, word choice, translation/wording corrections, formatting, phrases to always use or avoid; and (2) general operating/business POLICIES that apply broadly rather than to one specific existing product — e.g. 'minimum order is 5 pieces per product', 'always ask for the PIN code before confirming a delivery order', 'we don't deliver on Sundays'. Use this instead of add_knowledge_note whenever the instruction is meant to apply universally going forward, even if the owner illustrates it with one specific example or product (e.g. correcting a mistranslation in a Sorbhaja description, or saying 'ekhon theke shob product e minimum order 5 pcs' — both are general rules, not a fact about one product). The test: if a customer's question or order could come up for ANY product and this rule should still apply, it belongs here, not in update_product_info (which only touches one named existing product's own price/description) and not in add_knowledge_note (which is only reliably found by a closely-matching question, not enforced on every reply).",
    parameters: {
      type: "object",
      properties: {
        rule: {
          type: "string",
          description:
            "The rule itself, rewritten as a clear, standalone, general instruction the AI should always follow — not tied to one specific past reply or single product. E.g. 'Never translate \"cream\" as ক্রিম (সোর) — use দুধের সর. Use natural native Bengali, not literal English translations.' or 'Minimum order is 5 pieces per product unless a product's own listing says otherwise — never accept or confirm a smaller quantity without first telling the customer the minimum.'",
        },
      },
      required: ["rule"],
    },
  },
};

// Added 2026-08-20 — owner's own suggestion in chat: a customer can ask the
// SAME underlying question 10 different ways ("PIN match korle koto charge
// lagbe seta bole debe, na korle setao bole debe" was the real example that
// prompted this), and the answer itself can also reasonably be phrased 2-3
// different ways rather than one rigid fixed sentence. add_knowledge_note
// alone doesn't reliably solve this: it's one freeform paragraph embedded as
// a single chunk, so it's only found when a customer's wording happens to be
// close to however the owner originally phrased it. This tool instead asks
// the owner for SEVERAL realistic phrasings of the question up front and
// saves them all together as one structured Q&A block (via the same
// chunk+embed pipeline as add_knowledge_note) — so a customer's own novel
// phrasing is far more likely to land close to at least one of the examples,
// and the AI has real grounding to generalize from ("train itself further")
// instead of falling back to "I don't know" on a slightly different wording
// of something it's actually been taught. Deliberately NOT a rigid
// verbatim-match system — buildSystemPrompt's existing "answer only from the
// reference material, in your own natural words" instruction already applies
// here, same as any other knowledge source.
export const ADD_QA_PAIR_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "add_qa_pair",
    description:
      "Save a trained Q&A when the owner is teaching how to answer a specific kind of customer question — especially useful when they give (or you elicit) SEVERAL DIFFERENT WAYS a customer might ask the same thing. Unlike add_knowledge_note (one fact/topic, one phrasing), this is specifically for the shape 'when a customer asks something like X / Y / Z, the answer is something like A / B' — listing multiple phrasings of the SAME underlying question together so the AI reliably recognizes it even asked in a slightly different way than any single example, instead of defaulting to \"I don't know.\" Before calling this, if the owner has only given ONE way of asking and ONE answer, ask them for a couple more realistic phrasings of the question (and, if it naturally varies, 1-2 more ways to phrase the answer) so this is actually useful — don't call this tool with just a single question and single answer unless the owner makes clear that's genuinely all there is.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "A short label for this Q&A, e.g. 'Delivery charge confirmation' or 'COD availability'.",
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description:
            "Several different realistic ways a customer might phrase this same question — ideally 3 or more. The more real variations given, the more reliably the AI recognizes this question later, even phrased slightly differently than any one of these examples.",
        },
        answers: {
          type: "array",
          items: { type: "string" },
          description:
            "1-3 approved ways to answer this question, written out in full (a single answer is fine if that's genuinely all the owner gave). The AI treats these as its source of truth and answers in its own natural words based on them — not necessarily verbatim, but never contradicting what's said here.",
        },
      },
      required: ["questions", "answers"],
    },
  },
};

// Distinct from askAIWithTools's buildSystemPrompt: that one frames the model
// as a customer-facing WhatsApp assistant, which is the wrong persona for this
// internal owner-only chat. This system prompt is intentionally small and
// direct — the owner is teaching, not being sold to.
export async function askTeachAI(
  message: string,
  history: ChatHistoryMessage[],
  tools: ToolDefinition[],
  executeTool: ToolExecutor
): Promise<AiCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const systemPrompt = `You are helping a small business owner update their WhatsApp AI assistant's knowledge, by chatting naturally with them in whatever mix of Bengali/English they use — reply in kind. They will tell you things like a price change, a new policy, a general fact to remember, or a correction to how the AI writes/behaves.

Four tools, pick carefully:
- update_product_info — ONLY for correcting a NAMED, existing product's own price or description (the rule only ever applies to that one specific product).
- update_style_rule — for a standing rule that should apply on EVERY future reply, going forward, no matter what's being discussed. Two common shapes: (a) HOW the AI should write or behave — tone, word choice, translation/wording corrections, formatting, phrases to use or avoid; (b) a general operating/business POLICY that isn't scoped to one product — e.g. "minimum order is 5 pieces per product from now on", "always ask for the PIN code before confirming a delivery order", "no deliveries on Sundays". Use this even when the owner illustrates the rule with one specific example or product (e.g. pointing out a mistranslation in one product's description, or setting a minimum-order rule while mentioning one product) — the underlying rule is general and should apply everywhere, not just to that one instance. This is the most commonly missed case: a message that LOOKS like it's about one product but is actually teaching a general rule belongs here, not in update_product_info or add_knowledge_note — using the wrong tool means the rule silently never gets applied consistently again.
- add_qa_pair — when the owner is teaching how to answer a specific kind of question customers ask, especially when several different phrasings of that same question naturally come up (or you can reasonably elicit a couple more from them). Prefer this over add_knowledge_note whenever the shape is "customers ask this in different ways, answer like this" — it's specifically built to generalize across phrasing, which a single freeform paragraph is not. If the owner only gives one phrasing, briefly ask for 2-3 more realistic ways a customer might ask the same thing before saving (and up to a couple ways to phrase the answer, if that varies) — this tool is much less useful with just one example of each.
- add_knowledge_note — for a new FACT that answers a specific question when asked, but does NOT need to be actively applied/enforced on every reply and isn't naturally a multi-phrasing Q&A (store hours, a new offer, a one-off detail). If in doubt between this and update_style_rule, ask: "should this change how the AI behaves on every reply, or just be available if someone asks about this exact topic?" — the former is update_style_rule.

If you're not confident which applies, ask a short clarifying question instead of guessing or calling a tool.

After a tool call succeeds, confirm briefly and plainly what you saved/updated — don't repeat the full content back at length, just enough for the owner to trust it was understood correctly. Keep replies short — this is a quick back-and-forth, not a report.`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message },
  ];

  const first = await callChat(apiKey, messages, tools);
  let promptTokens = first.usage.promptTokens;
  let completionTokens = first.usage.completionTokens;

  const toolCalls = first.message.tool_calls as
    | { id: string; function: { name: string; arguments: string } }[]
    | undefined;

  if (!toolCalls || toolCalls.length === 0) {
    return { answer: (first.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
  }

  messages.push(first.message);

  for (const call of toolCalls) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // malformed JSON from the model — leave args empty, executeTool can reject it
    }

    let resultText: string;
    try {
      resultText = await executeTool(call.function.name, args);
    } catch (err) {
      resultText = `Failed: ${(err as Error).message}`;
    }

    messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
  }

  const second = await callChat(apiKey, messages, []);
  promptTokens += second.usage.promptTokens;
  completionTokens += second.usage.completionTokens;

  return { answer: (second.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
}

export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<string>;

type ChatMessage = Record<string, any>;

async function callChat(
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolDefinition[]
): Promise<{ message: ChatMessage; usage: TokenUsage }> {
  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI chat completion failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return { message: data.choices[0].message, usage: extractUsage(data) };
}

// Same idea as askAI, but with tools the model can call. Runs up to two
// completion calls: the first may return tool_calls instead of (or alongside)
// text; each tool call is executed via `executeTool`, and a second call turns
// the tool results into a normal reply the customer actually sees.
export async function askAIWithTools(
  question: string,
  sources: SourceChunk[],
  profile: AgentProfileInput | undefined,
  tools: ToolDefinition[],
  executeTool: ToolExecutor,
  history: ChatHistoryMessage[] = [],
  photoNote: string = "",
  catalogProducts: CatalogProduct[] = [],
  businessRulesNote: string | null = null
): Promise<AiCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  if (tools.length === 0) {
    return askAI(question, sources, profile, history, photoNote, catalogProducts, businessRulesNote);
  }

  const contextBlock = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(profile, contextBlock, true, photoNote, catalogProducts, businessRulesNote);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: question },
  ];

  const first = await callChat(apiKey, messages, tools);
  let promptTokens = first.usage.promptTokens;
  let completionTokens = first.usage.completionTokens;

  const toolCalls = first.message.tool_calls as
    | { id: string; function: { name: string; arguments: string } }[]
    | undefined;

  if (!toolCalls || toolCalls.length === 0) {
    return { answer: (first.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
  }

  messages.push(first.message);

  for (const call of toolCalls) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // malformed JSON from the model — leave args empty, executeTool can reject it
    }

    let resultText: string;
    try {
      resultText = await executeTool(call.function.name, args);
    } catch (err) {
      resultText = `Failed: ${(err as Error).message}`;
    }

    messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
  }

  // Second call has no tools available — it just turns the tool result(s)
  // into the actual reply text. Usage from BOTH calls counts toward real cost.
  const second = await callChat(apiKey, messages, []);
  promptTokens += second.usage.promptTokens;
  completionTokens += second.usage.completionTokens;

  return { answer: (second.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
}

// ---- Self-analysis (nightly batch, see /api/cron/self-analysis) ----
// The AI reviews a transcript of its OWN closed conversation and self-critiques.
// This is intentionally NOT run per-chat (that's an extra OpenAI call every
// single conversation) — it's a once-daily batch job the owner opts into.
// Output is always just a suggestion for the owner to review on the Training
// Dashboard; nothing here writes to the Knowledge Base or Custom Instructions
// on its own.
export type ConversationInsightResult = {
  mistakes: string;
  unanswered: string;
  suggestedKnowledge: string;
  suggestedRules: string;
};

export type ConversationInsightCallResult = { result: ConversationInsightResult | null; usage: TokenUsage };

export async function analyzeConversationForInsights(
  transcript: { sender: string; content: string }[],
  businessName?: string | null
): Promise<ConversationInsightCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  if (transcript.length === 0) return { result: null, usage: { promptTokens: 0, completionTokens: 0 } };

  const transcriptText = transcript
    .map((m) => `${m.sender}: ${m.content}`)
    .join("\n");

  const systemPrompt = `You are reviewing your OWN past conversation as the WhatsApp AI assistant for ${
    businessName?.trim() || "this business"
  }, to honestly self-critique your performance. Be specific and concrete — vague generic feedback isn't useful. If you genuinely did fine and there's nothing meaningful to flag, say so plainly in each field rather than inventing a problem.

Respond ONLY with a JSON object with exactly these four string fields (empty string "" if nothing applies to that field):
{
  "mistakes": "Specific mistakes you made in this conversation, if any (wrong info, bad tone, missed context, repeated itself, etc.)",
  "unanswered": "Specific questions from the customer you couldn't answer or answered poorly",
  "suggestedKnowledge": "Specific facts/info that should be added to the Knowledge Base to answer this better next time",
  "suggestedRules": "A specific new Custom Instruction rule that would have helped in this conversation, if any"
}`;

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Transcript:\n${transcriptText}` },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI self-analysis call failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const usage = extractUsage(data);
  const raw = data.choices[0].message.content as string;

  try {
    const parsed = JSON.parse(raw);
    return {
      result: {
        mistakes: (parsed.mistakes ?? "").toString().trim(),
        unanswered: (parsed.unanswered ?? "").toString().trim(),
        suggestedKnowledge: (parsed.suggestedKnowledge ?? "").toString().trim(),
        suggestedRules: (parsed.suggestedRules ?? "").toString().trim(),
      },
      usage,
    };
  } catch {
    return { result: null, usage }; // malformed JSON from the model — skip this conversation, cron continues to the next
  }
}
