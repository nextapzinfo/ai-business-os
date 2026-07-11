"use client";

import { useState } from "react";
import { saveAgentProfile, type AgentProfileData } from "@/app/dashboard/agent/actions";

type SandboxMessage = { role: "user" | "assistant"; text: string };

export default function AgentStudioClient({ initialProfile }: { initialProfile: AgentProfileData }) {
  const [form, setForm] = useState<AgentProfileData>(initialProfile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* Left: configuration form */}
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Business Profile</h3>
          <p className="mt-1 text-xs text-gray-500">Who the AI represents — used in every WhatsApp reply.</p>
          <div className="mt-3 flex flex-col gap-2">
            <label className="text-xs font-medium text-gray-600">
              Business name
              <input
                value={form.businessName}
                onChange={(e) => update("businessName", e.target.value)}
                placeholder="e.g. Banglar Doi"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-gray-600">
              What the business does
              <textarea
                value={form.businessDescription}
                onChange={(e) => update("businessDescription", e.target.value)}
                placeholder="e.g. a Bengali sweets and dairy shop selling doi, ghee, and traditional sweets"
                rows={2}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Greeting message (sent word-for-word to a new customer's first message)
              <textarea
                value={form.greetingMessage}
                onChange={(e) => update("greetingMessage", e.target.value)}
                placeholder="e.g. Thank you for contacting Banglar Doi! How can we help you today?"
                rows={2}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Voice</h3>
          <p className="mt-1 text-xs text-gray-500">How the AI sounds when it replies.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-xs font-medium text-gray-600">
              Tone
              <select
                value={form.tone}
                onChange={(e) => update("tone", e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
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
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="mixed">Match customer (Bengali/English mix)</option>
                <option value="bn">Bengali only</option>
                <option value="en">English only</option>
              </select>
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Skills</h3>
          <p className="mt-1 text-xs text-gray-500">
            Toggle what the AI is allowed to do. <span className="font-medium text-amber-600">Note:</span> automation
            for these isn't built yet — enabling them here just records the setting for now.
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

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
          {saved && <span className="text-xs font-medium text-accent">Saved — now live for real customers.</span>}
        </div>
      </div>

      {/* Right: test sandbox */}
      <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Test Sandbox</h3>
        <p className="mt-1 text-xs text-gray-500">
          Try questions here using whatever is currently typed on the left (even if not saved yet) — nothing here
          reaches real customers or gets logged as a conversation.
        </p>

        <div className="mt-3 flex-1 space-y-2 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3" style={{ minHeight: 280, maxHeight: 420 }}>
          {sandboxMessages.length === 0 && (
            <p className="text-xs text-gray-400">No messages yet — type a test question below.</p>
          )}
          {sandboxMessages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
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
  );
}
