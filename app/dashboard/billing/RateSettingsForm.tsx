import { updateBillingRates } from "./actions";

// Collapsed by default (<details>) — most days nobody needs to touch this,
// it's just the assumptions behind the ESTIMATE numbers. Plain server
// action + native <details>, no client JS needed for the collapse behavior.
export default function RateSettingsForm({
  usdToInrRate,
  costPerMarketingMsg,
  costPerUtilityMsg,
  costPerAuthMsg,
  costPerConversation,
}: {
  usdToInrRate: number;
  costPerMarketingMsg: number;
  costPerUtilityMsg: number;
  costPerAuthMsg: number;
  costPerConversation: number;
}) {
  return (
    <details className="rounded-xl border border-gray-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-gray-900">Cost rate assumptions</summary>
      <p className="mt-1 text-xs text-gray-500">
        These drive the WhatsApp cost ESTIMATES above — Meta's actual charge depends on the recipient's country and
        can change over time. The authoritative number always lives in Meta's own Billing dashboard
        (business.facebook.com). OpenAI cost is never estimated here — it's computed exactly from real token usage.
      </p>
      <form action={updateBillingRates} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="USD → INR rate" name="usdToInrRate" defaultValue={usdToInrRate} step="0.01" />
        <Field label="Marketing msg (USD)" name="costPerMarketingMsg" defaultValue={costPerMarketingMsg} step="0.0001" />
        <Field label="Utility msg (USD)" name="costPerUtilityMsg" defaultValue={costPerUtilityMsg} step="0.0001" />
        <Field label="Authentication msg (USD)" name="costPerAuthMsg" defaultValue={costPerAuthMsg} step="0.0001" />
        <Field label="Per-conversation (USD)" name="costPerConversation" defaultValue={costPerConversation} step="0.0001" />
        <div className="flex items-end">
          <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
            Save Rates
          </button>
        </div>
      </form>
    </details>
  );
}

function Field({ label, name, defaultValue, step }: { label: string; name: string; defaultValue: number; step: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-gray-600">{label}</span>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue}
        step={step}
        min="0"
        required
        className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
      />
    </label>
  );
}
