import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { PushSetup } from "@/components/PushSetup";
import { AI_QUIET_HOURS } from "@/lib/owner-notify";

export const dynamic = "force-dynamic";

async function saveAlertSettings(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;
  const mode = String(formData.get("ownerNotifyMode") || "IMPORTANT");
  const tpl = String(formData.get("ownerNotifyTemplateId") || "");
  await prisma.agentProfile.update({
    where: { organizationId: user.organizationId },
    data: {
      ownerNotifyMode: ["ALL", "IMPORTANT", "OFF"].includes(mode) ? mode : "IMPORTANT",
      ownerNotifyTemplateId: tpl || null,
      learnFromReplies: formData.get("learnFromReplies") === "on",
    },
  });
  revalidatePath("/dashboard/notifications");
}

// Notifications (2026-11-26): customer messages straight to the owner's
// WhatsApp (swipe-reply to answer) and as phone notifications.
export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [profile, templates, phones] = await Promise.all([
    prisma.agentProfile.findUnique({ where: { organizationId: user.organizationId } }),
    prisma.messageTemplate.findMany({ where: { organizationId: user.organizationId, status: "APPROVED" }, orderBy: { name: "asc" } }),
    prisma.pushSubscription.count({ where: { organizationId: user.organizationId } }),
  ]);
  const ownerReady = !!(profile?.skillOwnerAssistant && profile.ownerAssistantPhone);
  const card = "rounded-xl border border-gray-200 bg-white p-4 shadow-sm";

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-xl font-semibold text-gray-900">🔔 Notifications</h1>
      <p className="text-sm text-gray-600">কোনো ক্রেতা WhatsApp-এ মেসেজ করলে সঙ্গে সঙ্গে জানুন, আর ফোন থেকেই উত্তর দিন।</p>

      <section className={card}>
        <h2 className="text-base font-semibold text-gray-900">১) আপনার WhatsApp-এ</h2>
        {ownerReady ? (
          <p className="mt-1 text-sm text-gray-700">
            খবর যাবে <b>{profile!.ownerAssistantPhone}</b> নম্বরে। মেসেজটায় <b>Reply</b> করে (বাঁদিকে টেনে) লিখুন বা বলুন — সরাসরি ক্রেতার কাছে চলে যাবে। তারপর AI ঐ chat-এ {AI_QUIET_HOURS} ঘণ্টা চুপ থাকবে; আগেই চালু করতে Reply করে লিখুন <b>AI on</b> (বন্ধ রাখতে <b>AI off</b>)।
          </p>
        ) : (
          <p className="mt-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            আগে Agent Studio → <b>Owner Assistant</b> চালু করে আপনার নম্বর দিন।
          </p>
        )}
        <form action={saveAlertSettings} className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-gray-700">
            কোন মেসেজের খবর আসবে (WhatsApp + phone দুটোতেই)
            <select name="ownerNotifyMode" defaultValue={profile?.ownerNotifyMode || "IMPORTANT"} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="IMPORTANT">শুধু দরকারি — নতুন ক্রেতা, AI পারেনি / আপনাকে ডেকেছে / বন্ধ, অর্ডার, ছবি</option>
              <option value="ALL">সব মেসেজ</option>
              <option value="OFF">বন্ধ</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Template (২৪ ঘণ্টা আপনি business নম্বরে মেসেজ না করলে লাগবে)
            <select name="ownerNotifyTemplateId" defaultValue={profile?.ownerNotifyTemplateId || ""} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">— নেই —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs font-normal text-gray-500">
              Templates পাতায় একটা UTILITY template বানান, যেমন: <i>নতুন মেসেজ — {"{{1}}"}: {"{{2}}"}। উত্তর দিতে এই মেসেজে Reply করুন।</i> Approve হলে এখানে বেছে নিন।
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" name="learnFromReplies" defaultChecked={profile?.learnFromReplies !== false} className="mt-1" />
            <span>
              📚 <b>আমার উত্তর থেকে শেখো</b> — আপনি নিজে কোনো ক্রেতাকে উত্তর দিলে (দাম, নিয়ম, ডেলিভারি ইত্যাদি), AI WhatsApp-এ জিজ্ঞেস করবে "শিখে রাখব?"। Reply করে <b>হ্যাঁ</b> লিখলে তবেই শিখবে।
            </span>
          </label>
          <button className="rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white">Save</button>
        </form>
      </section>

      <section className={card}>
        <h2 className="text-base font-semibold text-gray-900">২) ফোনে notification (app-এর মতো)</h2>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-gray-700">
          <li>ফোনে Chrome দিয়ে AI Business OS খুলে login করুন।</li>
          <li>Chrome menu (⋮) → <b>Add to Home screen / Install app</b> — Home screen-এ আইকন আসবে।</li>
          <li>সেই আইকন থেকে খুলে এই পাতায় এসে নিচের বোতাম চাপুন।</li>
        </ol>
        <p className="mt-2 text-xs text-gray-500">এখন {phones}টা ফোন/browser-এ চালু আছে। notification-এ চাপলে সরাসরি ঐ ক্রেতার chat খুলবে।</p>
        <div className="mt-3">
          <PushSetup />
        </div>
      </section>
    </div>
  );
}
