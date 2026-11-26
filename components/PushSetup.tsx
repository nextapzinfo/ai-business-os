"use client";

import { useEffect, useState } from "react";

// "Turn on notifications on this phone" (2026-11-26).
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushSetup() {
  const [state, setState] = useState<"checking" | "unsupported" | "ios-install" | "off" | "on" | "blocked">("checking");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    (async () => {
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setState(isIOS && !standalone ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setState("blocked");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  const turnOn = async () => {
    setBusy(true);
    setNote("");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "blocked" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = await fetch("/api/push/subscribe").then((r) => r.json());
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (!r.ok) throw new Error("save failed");
      setState("on");
      setNote("চালু হয়েছে ✓ — এখন একটা test পাঠিয়ে দেখুন।");
    } catch (e) {
      setNote("চালু করা গেল না: " + (e instanceof Error ? e.message : "error"));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState("off");
      setNote("এই ফোনে বন্ধ করা হলো।");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/push/test", { method: "POST" }).then((x) => x.json());
      setNote(r.sent ? `Test পাঠানো হলো (${r.sent}টা ফোন/browser) — কয়েক সেকেন্ডে notification আসবে।` : "কোনো ফোনে notification চালু নেই।");
    } finally {
      setBusy(false);
    }
  };

  const btn = "rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
  return (
    <div className="space-y-3">
      {state === "checking" && <p className="text-sm text-gray-500">Checking this phone…</p>}
      {state === "ios-install" && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          iPhone-এ আগে Safari-তে <b>Share → Add to Home Screen</b> করুন, তারপর Home screen-এর AI Business OS আইকন থেকে খুলে এই পাতায় এসে চালু করুন।
        </p>
      )}
      {state === "unsupported" && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">এই browser-এ notification হয় না — Android-এ Chrome দিয়ে খুলুন।</p>}
      {state === "blocked" && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          Notification ব্লক করা আছে। Chrome-এ ঠিকানার পাশের 🔒 চিহ্নে চাপুন → Notifications → Allow, তারপর পাতাটা reload করুন।
        </p>
      )}
      {state === "off" && (
        <button type="button" disabled={busy} onClick={turnOn} className={`${btn} bg-emerald-700 text-white`}>
          🔔 এই ফোনে notification চালু করুন
        </button>
      )}
      {state === "on" && (
        <div className="flex flex-wrap gap-2">
          <span className="rounded-lg bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800">✓ এই ফোনে চালু আছে</span>
          <button type="button" disabled={busy} onClick={test} className={`${btn} border border-gray-300 bg-white`}>
            Test পাঠান
          </button>
          <button type="button" disabled={busy} onClick={turnOff} className={`${btn} border border-gray-300 bg-white text-gray-600`}>
            বন্ধ করুন
          </button>
        </div>
      )}
      {note && <p className="text-sm text-gray-700">{note}</p>}
    </div>
  );
}
