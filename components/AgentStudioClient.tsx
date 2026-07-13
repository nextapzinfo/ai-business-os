"use client";

import { useState } from "react";
import { Building2, Volume2, Zap, BookOpen, Check, QrCode, Plus, X, Pencil } from "lucide-react";
import {
  saveAgentProfile,
  addKnowledgeDocument,
  uploadKnowledgeFile,
  crawlWebsite,
  updateKnowledgeDocument,
  deleteKnowledgeDocument,
  uploadQrCode,
  deleteQrCode,
  type AgentProfileData,
} from "@/app/dashboard/agent/actions";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";
import { formatDate } from "@/lib/formatDate";

type SandboxMessage = { role: "user" | "assistant"; text: string };

type KnowledgeDocument = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  linkedToProduct: boolean;
  content: string;
};

type TabKey = "profile" | "voice" | "skills" | "knowledge";

type TerminologyPair = { from: string; to: string };
type BrandLanguageState = { wordsToUse: string; wordsToAvoid: string; terminology: TerminologyPair[] };

// AgentProfileData.brandLanguage is stored as a single JSON string in the DB
// (so no extra columns are needed), but staff edit it through a friendly
// structured table — these two functions convert between the two shapes.
function parseBrandLanguage(raw: string): BrandLanguageState {
  if (!raw) return { wordsToUse: "", wordsToAvoid: "", terminology: [] };
  try {
    const parsed = JSON.parse(raw) as {
      wordsToUse?: string[];
      wordsToAvoid?: string[];
      terminology?: TerminologyPair[];
    };
    return {
      wordsToUse: (parsed.wordsToUse ?? []).join(", "),
      wordsToAvoid: (parsed.wordsToAvoid ?? []).join(", "),
      terminology: parsed.terminology ?? [],
    };
  } catch {
    return { wordsToUse: "", wordsToAvoid: "", terminology: [] };
  }
}

function serializeBrandLanguage(data: BrandLanguageState): string {
  return JSON.stringify({
    wordsToUse: data.wordsToUse.split(",").map((w) => w.trim()).filter(Boolean),
    wordsToAvoid: data.wordsToAvoid.split(",").map((w) => w.trim()).filter(Boolean),
    terminology: data.terminology.filter((t) => t.from.trim() && t.to.trim()),
  });
}

const TABS: { key: TabKey; label: string; icon: typeof Building2 }[] = [
  { key: "profile", label: "Business Profile", icon: Building2 },
  { key: "voice", label: "Voice", icon: Volume2 },
  { key: "skills", label: "Skills", icon: Zap },
  { key: "knowledge", label: "Knowledge", icon: BookOpen },
];

const inputClass = "mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm";

export default function AgentStudioClient({
  initialProfile,
  initialDocuments,
  qrCodeUrl,
}: {
  initialProfile: AgentProfileData;
  initialDocuments: KnowledgeDocument[];
  qrCodeUrl: string | null;
}) {
  const [form, setForm] = useState<AgentProfileData>(initialProfile);
  const [activeTab, setActiveTab] = useState<TabKey>("profile");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true);

  const [brandLang, setBrandLang] = useState<BrandLanguageState>(() =>
    parseBrandLanguage(initialProfile.brandLanguage)
  );

  function updateBrandLang(next: BrandLanguageState) {
    setBrandLang(next);
    update("brandLanguage", serializeBrandLanguage(next));
  }

  // Custom instructions are stored as one big newline-separated string in the
  // DB (AgentProfileData.customInstructions), same trick as Brand Language —
  // but staff manage them here as a proper list: add one at a time, edit or
  // delete any single line, without touching the others.
  const [instructions, setInstructions] = useState<string[]>(() =>
    initialProfile.customInstructions
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const [newInstruction, setNewInstruction] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");

  function commitInstructions(next: string[]) {
    setInstructions(next);
    update("customInstructions", next.join("\n"));
  }

  function addInstruction() {
    const val = newInstruction.trim();
    if (!val) return;
    commitInstructions([...instructions, val]);
    setNewInstruction("");
  }

  function removeInstruction(i: number) {
    commitInstructions(instructions.filter((_, idx) => idx !== i));
    if (editingIndex === i) setEditingIndex(null);
  }

  function startEditInstruction(i: number) {
    setEditingIndex(i);
    setEditingValue(instructions[i]);
  }

  function commitEditInstruction() {
    if (editingIndex === null) return;
    const val = editingValue.trim();
    if (!val) {
      removeInstruction(editingIndex);
    } else {
      const next = [...instructions];
      next[editingIndex] = val;
      commitInstructions(next);
    }
    setEditingIndex(null);
  }

  const [sandboxMessages, setSandboxMessages] = useState<SandboxMessage[]>([]);
  const [sandboxInput, setSandboxInput] = useState("");
  const [sandboxLoading, setSandboxLoading] = useState(false);

  function update<K extends keyof AgentProfileData>(key: K, value: AgentProfileData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveAgentProfile(form);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function handleTestSend() {
    const question = sandboxInput.trim();
    if (!question) return;
    setSandboxMessages((prev) => [...prev, { role: "user", text: question }]);
    setSandboxInput("");
    setSandboxLoading(true);
    try {
      const res = await fetch("/api/agent/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          history: sandboxMessages.map((m) => ({ role: m.role, content: m.text })),
          businessName: form.businessName,
          businessDescription: form.businessDescription,
          coreIdentity: form.coreIdentity,
          customInstructions: form.customInstructions,
          brandLanguage: form.brandLanguage,
          tone: form.tone,
          languageStyle: form.languageStyle,
          skillSaveAddress: form.skillSaveAddress,
          skillReminders: form.skillReminders,
          skillTrackInterest: form.skillTrackInterest,
          skillTakeOrders: form.skillTakeOrders,
        }),
      });
      const data = await res.json();
      setSandboxMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.answer ?? data.error ?? "No response." },
      ]);
    } catch (err) {
      setSandboxMessages((prev) => [...prev, { role: "assistant", text: "Test failed — try again." }]);
    } finally {
      setSandboxLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Top bar: persistent save state, regardless of which tab is open */}
      <div className="flex flex-shrink-0 items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs">
          {saved ? (
            <span className="flex items-center gap-1 font-medium text-accent">
              <Check size={14} /> All changes saved
            </span>
          ) : (
            <span className="font-medium text-amber-600">Unsaved changes</span>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saving || saved}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      <div className="grid flex-1 grid-cols-1 items-start gap-5 lg:grid-cols-[150px_1fr_360px]">
        {/* Tab nav */}
        <div className="flex flex-row gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex flex-shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  isActive ? "bg-primary-dark text-white font-medium" : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                <Icon size={15} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Active tab content */}
        <div className="flex flex-col gap-4">
          {activeTab === "profile" && (
            <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-gray-200 bg-primary/5 p-4">
              <h3 className="text-sm font-semibold text-gray-900">Core AI Identity</h3>
              <p className="mt-1 text-xs text-gray-500">
                Who the AI fundamentally IS — its persona, voice, and how it thinks/judges things. Write this
                as a real paragraph, not bullet points. This has the strongest effect on how the AI actually
                behaves — more than any single rule below. For narrow, specific rules ("never mention
                competitors", "always offer delivery above ৳500"), use Custom Instructions instead — that's
                the right place for those, not here.
              </p>
              <textarea
                value={form.coreIdentity}
                onChange={(e) => update("coreIdentity", e.target.value)}
                placeholder={
                  'e.g. "You are a warm, experienced senior staff member at Banglar Doi, a three-generation ' +
                  'Bengali sweets and dairy shop. You know the regulars and speak like you personally remember ' +
                  'them. You take genuine pride in the quality of the doi and sweets, and you\'d rather gently ' +
                  'talk a customer out of over-ordering something that won\'t stay fresh than make a bigger sale. ' +
                  'You think like a trusted shopkeeper, not a call-center script."'
                }
                rows={6}
                className={`${inputClass} mt-3`}
              />
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900">Business Profile</h3>
              <p className="mt-1 text-xs text-gray-500">Who the AI represents — used in every WhatsApp reply.</p>
              <div className="mt-3 flex flex-col gap-3">
                <label className="text-xs font-medium text-gray-600">
                  Business name
                  <input
                    value={form.businessName}
                    onChange={(e) => update("businessName", e.target.value)}
                    placeholder="e.g. Banglar Doi"
                    className={inputClass}
                  />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  What the business does
                  <textarea
                    value={form.businessDescription}
                    onChange={(e) => update("businessDescription", e.target.value)}
                    placeholder="e.g. a Bengali sweets and dairy shop selling doi, ghee, and traditional sweets"
                    rows={3}
                    className={inputClass}
                  />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  Greeting message (sent word-for-word to a new customer's first message)
                  <textarea
                    value={form.greetingMessage}
                    onChange={(e) => update("greetingMessage", e.target.value)}
                    placeholder="e.g. Thank you for contacting Banglar Doi! How can we help you today?"
                    rows={3}
                    className={inputClass}
                  />
                </label>
                <div>
                  <p className="text-xs font-medium text-gray-600">Custom instructions</p>
                  <p className="text-[11px] font-normal text-gray-400">
                    Always-on rules for the AI — not just used when relevant like Knowledge, these apply to
                    every single reply. e.g. "Never mention competitor brands", "Always offer home delivery
                    for orders above ৳500", "If someone orders more than 5kg, tell them to call the shop
                    directly".
                  </p>

                  <div className="mt-2 flex flex-col gap-1.5">
                    {instructions.map((instr, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5"
                      >
                        {editingIndex === i ? (
                          <>
                            <input
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitEditInstruction();
                                if (e.key === "Escape") setEditingIndex(null);
                              }}
                              autoFocus
                              className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
                            />
                            <button
                              type="button"
                              onClick={commitEditInstruction}
                              className="flex-shrink-0 rounded-lg p-1.5 text-accent hover:bg-emerald-50"
                            >
                              <Check size={14} />
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="flex-1 text-xs text-gray-700">{instr}</span>
                            <button
                              type="button"
                              onClick={() => startEditInstruction(i)}
                              className="flex-shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-primary"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeInstruction(i)}
                              className="flex-shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                            >
                              <X size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                    {instructions.length === 0 && (
                      <p className="text-xs text-gray-400">No instructions yet — add one below.</p>
                    )}

                    <div className="flex items-center gap-2">
                      <input
                        value={newInstruction}
                        onChange={(e) => setNewInstruction(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addInstruction();
                        }}
                        placeholder="e.g. Never mention competitor brands"
                        className="flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                      />
                      <button
                        type="button"
                        onClick={addInstruction}
                        className="flex-shrink-0 rounded-lg border border-dashed border-gray-300 p-1.5 text-gray-500 hover:border-primary hover:text-primary"
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </div>
          )}

          {activeTab === "voice" && (
            <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900">Voice</h3>
              <p className="mt-1 text-xs text-gray-500">How the AI sounds when it replies.</p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-gray-600">
                  Tone
                  <select
                    value={form.tone}
                    onChange={(e) => update("tone", e.target.value)}
                    className={inputClass}
                  >
                    <optgroup label="Simple">
                      <option value="friendly">Friendly</option>
                      <option value="formal">Formal</option>
                      <option value="casual">Casual</option>
                    </optgroup>
                    <optgroup label="Brand personality">
                      <option value="traditional">Traditional</option>
                      <option value="premium">Premium</option>
                      <option value="luxury">Luxury</option>
                      <option value="professional">Professional</option>
                      <option value="humorous">Humorous</option>
                    </optgroup>
                  </select>
                </label>
                <label className="text-xs font-medium text-gray-600">
                  Language
                  <select
                    value={form.languageStyle}
                    onChange={(e) => update("languageStyle", e.target.value)}
                    className={inputClass}
                  >
                    <option value="mixed">Match customer (Bengali/English mix)</option>
                    <option value="bn">Bengali only</option>
                    <option value="en">English only</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900">Brand Language</h3>
              <p className="mt-1 text-xs text-gray-500">
                Your own vocabulary — e.g. "Mishti" instead of "Product", "Sweets" instead of "Goods". This
                is what keeps the AI sounding like your business instead of a generic assistant.
              </p>

              <div className="mt-3 flex flex-col gap-3">
                <label className="text-xs font-medium text-gray-600">
                  Words to use
                  <span className="block text-[11px] font-normal text-gray-400">
                    Comma-separated, e.g. Mishti, Doi, Laal Kheer Doi, Customer, Order, Fresh, Authentic
                  </span>
                  <textarea
                    value={brandLang.wordsToUse}
                    onChange={(e) => updateBrandLang({ ...brandLang, wordsToUse: e.target.value })}
                    placeholder="Mishti, Doi, Sweets, Customer, Order..."
                    rows={2}
                    className={inputClass}
                  />
                </label>

                <label className="text-xs font-medium text-gray-600">
                  Words to avoid
                  <span className="block text-[11px] font-normal text-gray-400">
                    Comma-separated generic words the AI should never use, e.g. Product, Goods, Consumers
                  </span>
                  <textarea
                    value={brandLang.wordsToAvoid}
                    onChange={(e) => updateBrandLang({ ...brandLang, wordsToAvoid: e.target.value })}
                    placeholder="Product, Goods, Item, Consumers..."
                    rows={2}
                    className={inputClass}
                  />
                </label>

                <div>
                  <p className="text-xs font-medium text-gray-600">Word swaps</p>
                  <p className="text-[11px] font-normal text-gray-400">
                    Exact replacements — e.g. never say "Laal Ghee Doi", always say "Laal Kheer Doi".
                  </p>
                  <div className="mt-2 flex flex-col gap-2">
                    {brandLang.terminology.map((pair, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={pair.from}
                          onChange={(e) => {
                            const next = [...brandLang.terminology];
                            next[i] = { ...next[i], from: e.target.value };
                            updateBrandLang({ ...brandLang, terminology: next });
                          }}
                          placeholder="Never say..."
                          className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                        />
                        <span className="flex-shrink-0 text-xs text-gray-400">→</span>
                        <input
                          value={pair.to}
                          onChange={(e) => {
                            const next = [...brandLang.terminology];
                            next[i] = { ...next[i], to: e.target.value };
                            updateBrandLang({ ...brandLang, terminology: next });
                          }}
                          placeholder="Always say..."
                          className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const next = brandLang.terminology.filter((_, idx) => idx !== i);
                            updateBrandLang({ ...brandLang, terminology: next });
                          }}
                          className="flex-shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        updateBrandLang({
                          ...brandLang,
                          terminology: [...brandLang.terminology, { from: "", to: "" }],
                        })
                      }
                      className="flex w-fit items-center gap-1 rounded-lg border border-dashed border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:border-primary hover:text-primary"
                    >
                      <Plus size={13} /> Add word swap
                    </button>
                  </div>
                </div>
              </div>
            </div>
            </div>
          )}

          {activeTab === "skills" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Skills</h3>
                <p className="mt-1 text-xs text-gray-500">
                  These are live — the AI actually decides mid-conversation whether to use them, based on what
                  the customer says.
                </p>
                <div className="mt-3 flex flex-col gap-3">
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.skillSaveAddress}
                      onChange={(e) => update("skillSaveAddress", e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Save customer address
                      <span className="block text-xs text-gray-400">
                        When a customer shares their address, the AI saves it to their client record.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.skillReminders}
                      onChange={(e) => update("skillReminders", e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Set reminders when asked
                      <span className="block text-xs text-gray-400">
                        When a customer asks to be followed up or reminded about something on a date, the AI
                        creates a reminder (visible on the Reminders page). Doesn't send the reminder message
                        automatically yet — that's tracked here for staff to action.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.skillTrackInterest}
                      onChange={(e) => update("skillTrackInterest", e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Remember product interest
                      <span className="block text-xs text-gray-400">
                        When a customer asks about, praises, or seems interested in a product from your
                        catalog, the AI notes it against their client record (visible on the Clients page) for
                        sales follow-up.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.skillSendEventPhotos}
                      onChange={(e) => update("skillSendEventPhotos", e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Send event photos
                      <span className="block text-xs text-gray-400">
                        When a customer asks about a festival special, sale, or announcement you've added
                        under Events, the AI sends that event's photo along with its answer.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.skillTakeOrders}
                      onChange={(e) => update("skillTakeOrders", e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Take orders (Order Assistant)
                      <span className="block text-xs text-gray-400">
                        Once the AI has confirmed the items/quantities (and delivery address, if needed) back
                        with the customer, it records the order for staff to action — visible on the Orders
                        page. It won't record anything before reading it back and getting a yes.
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Coming soon</h3>
                <p className="mt-1 text-xs text-gray-500">
                  <span className="font-medium text-amber-600">Note:</span> automation for this isn't built
                  yet — enabling it here just records the setting for now.
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.skillOrderConfirm}
                      onChange={(e) => update("skillOrderConfirm", e.target.checked)}
                    />
                    Confirm orders automatically
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <QrCode size={16} className="text-gray-500" />
                  <h3 className="text-sm font-semibold text-gray-900">Send Payment QR</h3>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Upload your real payment QR once (UPI or bank QR) — the AI sends this exact image whenever a
                  customer asks about payment. It never generates or changes the QR.
                </p>

                <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.skillSendQr}
                    onChange={(e) => update("skillSendQr", e.target.checked)}
                  />
                  Send this QR automatically when a customer asks about payment
                </label>

                <div className="mt-3 flex items-center gap-3">
                  {qrCodeUrl ? (
                    <img
                      src={qrCodeUrl}
                      alt="Payment QR"
                      className="h-20 w-20 flex-shrink-0 rounded-lg border border-gray-200 object-contain"
                    />
                  ) : (
                    <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-300 text-[10px] text-gray-400">
                      No QR yet
                    </div>
                  )}
                  <form action={uploadQrCode} className="flex flex-1 items-center gap-2">
                    <input type="file" name="qr" accept="image/*" required className="w-full text-xs" />
                    <button
                      type="submit"
                      className="flex-shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-light"
                    >
                      {qrCodeUrl ? "Change" : "Upload"}
                    </button>
                  </form>
                  {qrCodeUrl && (
                    <form action={deleteQrCode}>
                      <ConfirmSubmitButton
                        label="Remove"
                        confirmText="Remove the payment QR? The AI will stop sending it until you upload a new one."
                        className="flex-shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                      />
                    </form>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "knowledge" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Knowledge</h3>
                <p className="mt-1 text-xs text-gray-500">
                  The shared reference material your agent answers from. Paste text below to add it — the AI
                  only answers using what's here, and always cites its source.
                </p>
                <form action={addKnowledgeDocument} key={initialDocuments.length} className="mt-3 flex flex-col gap-2">
                  <input
                    name="title"
                    placeholder="Title (e.g. Delivery & Return Policy)"
                    required
                    className={inputClass}
                  />
                  <textarea
                    name="content"
                    placeholder="Paste the reference text here..."
                    required
                    rows={5}
                    className={inputClass}
                  />
                  <button
                    type="submit"
                    className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
                  >
                    Add to Knowledge Base
                  </button>
                </form>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Or upload a file</h3>
                <p className="mt-1 text-xs text-gray-500">
                  PDF, DOCX, TXT, or CSV — the text inside is extracted and added to the knowledge base
                  automatically.
                </p>
                <form action={uploadKnowledgeFile} key={`file-${initialDocuments.length}`} className="mt-3 flex flex-col gap-2">
                  <input
                    name="title"
                    placeholder="Title (optional — defaults to the file name)"
                    className={inputClass}
                  />
                  <input
                    type="file"
                    name="file"
                    accept=".pdf,.docx,.txt,.csv"
                    required
                    className="mt-1 w-full text-sm"
                  />
                  <button
                    type="submit"
                    className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
                  >
                    Upload File
                  </button>
                </form>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Or crawl a website</h3>
                <p className="mt-1 text-xs text-gray-500">
                  Give a public page URL (your website, an about/FAQ page) and its text gets added
                  automatically. Doesn't work for Facebook pages or anything behind a login — copy-paste
                  that content into "paste text" above instead.
                </p>
                <form action={crawlWebsite} key={`crawl-${initialDocuments.length}`} className="mt-3 flex flex-col gap-2">
                  <input
                    name="url"
                    type="url"
                    placeholder="https://yourbusiness.com/about"
                    required
                    className={inputClass}
                  />
                  <input
                    name="title"
                    placeholder="Title (optional — defaults to the page title)"
                    className={inputClass}
                  />
                  <button
                    type="submit"
                    className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
                  >
                    Crawl Page
                  </button>
                </form>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Sources ({initialDocuments.length})</h3>
                <div className="mt-3 flex flex-col divide-y divide-gray-100">
                  {initialDocuments.length === 0 && (
                    <p className="py-3 text-xs text-gray-400">No knowledge sources yet — add one above.</p>
                  )}
                  {initialDocuments.map((doc) => (
                    <div key={doc.id} className="py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-800">{doc.title}</p>
                          <p className="mt-0.5 text-xs text-gray-400">
                            {formatDate(new Date(doc.createdAt))} ·{" "}
                            <span
                              className={
                                doc.status === "PROCESSED"
                                  ? "text-accent"
                                  : doc.status === "FAILED"
                                  ? "text-red-500"
                                  : "text-amber-500"
                              }
                            >
                              {doc.status}
                            </span>
                          </p>
                        </div>
                        {doc.linkedToProduct ? (
                          <span className="flex-shrink-0 text-xs text-gray-400">Managed on Products page</span>
                        ) : (
                          <form action={deleteKnowledgeDocument} className="flex-shrink-0">
                            <input type="hidden" name="documentId" value={doc.id} />
                            <ConfirmSubmitButton
                              label="Delete"
                              confirmText={`Delete "${doc.title}" from the knowledge base? This can't be undone.`}
                              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                            />
                          </form>
                        )}
                      </div>

                      {!doc.linkedToProduct && (
                        <details className="mt-2 rounded-lg border border-gray-200">
                          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium text-gray-600">
                            Edit content
                          </summary>
                          <form action={updateKnowledgeDocument} className="flex flex-col gap-1.5 p-2.5 pt-0">
                            <input type="hidden" name="documentId" value={doc.id} />
                            <input
                              name="title"
                              defaultValue={doc.title}
                              required
                              placeholder="Title"
                              className="rounded border border-gray-300 px-2 py-1 text-xs"
                            />
                            <textarea
                              name="content"
                              defaultValue={doc.content}
                              required
                              rows={6}
                              placeholder="Source text"
                              className="rounded border border-gray-300 px-2 py-1 text-xs"
                            />
                            <button
                              type="submit"
                              className="mt-1 self-start rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light"
                            >
                              Save Changes
                            </button>
                          </form>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Test Sandbox — persistent regardless of active tab */}
        <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Test Sandbox</h3>
          <p className="mt-1 text-xs text-gray-500">
            Try questions here using whatever is currently typed (even if not saved yet) — nothing here reaches
            real customers or gets logged as a conversation.
          </p>

          <div
            className="mt-3 flex-1 space-y-2 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3"
            style={{ minHeight: 280, maxHeight: 480 }}
          >
            {sandboxMessages.length === 0 && (
              <p className="text-xs text-gray-400">No messages yet — type a test question below.</p>
            )}
            {sandboxMessages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === "user" ? "bg-primary text-white" : "border border-gray-200 bg-white text-gray-800"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {sandboxLoading && <p className="text-xs text-gray-400">Thinking...</p>}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={sandboxInput}
              onChange={(e) => setSandboxInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTestSend();
              }}
              placeholder="Type a test question..."
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <button
              onClick={handleTestSend}
              disabled={sandboxLoading}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-60"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
