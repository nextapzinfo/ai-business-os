import { downloadWhatsAppMedia } from "@/lib/whatsapp";

// Voice notes (2026-11-20, owner: "ami voice e bollam but seta recognize
// korte parlo na"). WhatsApp sends a voice note as type "audio" with a media
// id; we download it (.ogg/opus) and turn it into text with OpenAI's speech
// to text, then treat it exactly like a typed message. Currently used for
// the owner's own Owner Assistant / Business Analyst number only.
const MODELS = ["gpt-4o-mini-transcribe", "whisper-1"];
const HINT =
  "Banglar Doi, Bengali sweets shop in Kolkata. Bengali and English mixed. Words like sale, target, event, Trade Fair, Patuli, Madhyamgram, rosogolla, sandesh, doi, mishti, closing, short, lakh, hajar.";

export async function transcribeWhatsAppAudio(mediaId: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const { buffer, contentType } = await downloadWhatsAppMedia(mediaId);
  const ext = contentType.includes("mpeg") ? "mp3" : contentType.includes("mp4") || contentType.includes("aac") ? "m4a" : "ogg";
  let lastError = "";
  for (const model of MODELS) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType.split(";")[0] || "audio/ogg" }), `voice.${ext}`);
    form.append("model", model);
    form.append("prompt", HINT);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (res.ok) {
      const data = (await res.json()) as { text?: string };
      return (data.text || "").trim();
    }
    lastError = `${model}: ${res.status} ${await res.text()}`;
  }
  throw new Error(`Transcription failed — ${lastError}`);
}
