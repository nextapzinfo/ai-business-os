"use client";

import { useState } from "react";
import { Building2, Volume2, Zap, BookOpen, Check, QrCode } from "lucide-react";
import {
  saveAgentProfile,
  addKnowledgeDocument,
  uploadKnowledgeFile,
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
};

type TabKey = "profile" | "voice" | "skills" | "knowledge";

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
          businessName: form.businessName,
          businessDescription: form.businessDescription,
          tone: form.tone,
          languageStyle: form.languageStyle,
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
              </div>
            </div>
          )}

          {activeTab === "voice" && (
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
                    <option value="friendly">Friendly</option>
                    <option value="formal">Formal</option>
                    <option value="casual">Casual</option>
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
          )}

          {activeTab === "skills" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-gray-900">Skills</h3>
                <p className="mt-1 text-xs text-gray-500">
                  Toggle what the AI is allowed to do. <span className="font-medium text-amber-600">Note:</span>{" "}
                  order-confirm and reminder automation aren't built yet — enabling them here just records the
                  setting for now.
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
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.skillReminders}
                      onChange={(e) => update("skillReminders", e.target.checked)}
                    />
                    Send automatic follow-up reminders
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
                <h3 className="text-sm font-semibold text-gray-900">Sources ({initialDocuments.length})</h3>
                <div className="mt-3 flex flex-col divide-y divide-gray-100">
                  {initialDocuments.length === 0 && (
                    <p className="py-3 text-xs text-gray-400">No knowledge sources yet — add one above.</p>
                  )}
                  {initialDocuments.map((doc) => (
                    <div key={doc.id} className="flex items-center justify-between gap-3 py-2.5">
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
