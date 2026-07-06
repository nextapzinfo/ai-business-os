import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { chunkText } from "@/lib/chunk";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { askAI } from "@/lib/llm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

async function addDocument(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const title = formData.get("title") as string;
  const content = formData.get("content") as string;
  if (!title || !content) return;

  const document = await prisma.document.create({
    data: {
      organizationId: user.organizationId,
      title,
      fileUrl: "pasted-text", // no file storage yet — Phase 2 accepts pasted text for V1
      status: "PENDING",
    },
  });

  try {
    const pieces = chunkText(content);

    for (let i = 0; i < pieces.length; i++) {
      const chunk = await prisma.documentChunk.create({
        data: {
          organizationId: user.organizationId,
          documentId: document.id,
          content: pieces[i],
          chunkIndex: i,
        },
      });

      const embedding = await embedText(pieces[i], "document");
      const vectorLiteral = toVectorLiteral(embedding);

      await prisma.$executeRaw`
        UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunk.id}
      `;
    }

    await prisma.document.update({
      where: { id: document.id },
      data: { status: "PROCESSED" },
    });
  } catch (err) {
    await prisma.document.update({
      where: { id: document.id },
      data: { status: "FAILED" },
    });
    console.error("Document processing failed:", err);
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DOCUMENT_UPLOADED",
    metadata: { documentId: document.id, title },
  });

  revalidatePath("/dashboard/documents");
}

async function askQuestion(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  const question = formData.get("question") as string;
  if (!user || !question) return;

  const queryEmbedding = await embedText(question, "query");
  const vectorLiteral = toVectorLiteral(queryEmbedding);

  const results = await prisma.$queryRaw
    { content: string; documentTitle: string }[]
  >`
    SELECT dc.content as content, d.title as "documentTitle"
    FROM "DocumentChunk" dc
    JOIN "Document" d ON d.id = dc."documentId"
    WHERE dc."organizationId" = ${user.organizationId}
    ORDER BY dc.embedding <=> ${vectorLiteral}::vector ASC
    LIMIT 5
  `;

  let answer: string;
  if (results.length === 0) {
    answer =
      "No documents have been uploaded yet, so I don't have anything to answer from.";
  } else {
    answer = await askAI(
      question,
      results.map((r) => ({ title: r.documentTitle, content: r.content }))
    );
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "KNOWLEDGE_BASE_QUERIED",
    metadata: { question },
  });

  redirect(
    `/dashboard/documents?question=${encodeURIComponent(question)}&answer=${encodeURIComponent(answer)}`
  );
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams?: { question?: string; answer?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  const documents = await prisma.document.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1>Knowledge Base</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Paste GST/Income Tax reference text below to add it to the knowledge
        base, then ask questions — answers are generated only from what's
        uploaded here, with sources cited.
      </p>

      <h3 style={{ marginTop: 24 }}>Upload document text</h3>
      <form
        action={addDocument}
        style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 600 }}
      >
        <input name="title" placeholder="Title (e.g. GST Return Filing Rules)" required style={inputStyle} />
        <textarea
          name="content"
          placeholder="Paste the reference text here..."
          required
          rows={8}
          style={{ ...inputStyle, fontFamily: "inherit" }}
        />
        <button type="submit" style={{ ...buttonStyle, alignSelf: "flex-start" }}>
          Upload &amp; Process
        </button>
      </form>

      <h3 style={{ marginTop: 32 }}>Ask AI</h3>
      <form
        action={askQuestion}
        style={{ display: "flex", gap: 8, maxWidth: 600, flexWrap: "wrap" }}
      >
        <input
          name="question"
          placeholder="e.g. When is the GST return due this quarter?"
          required
          style={{ ...inputStyle, flex: "1 1 300px" }}
        />
        <button type="submit" style={buttonStyle}>
          Ask
        </button>
      </form>

      {searchParams?.answer && (
        <div
          style={{
            marginTop: 16,
            maxWidth: 600,
            background: "#fff",
            border: "1px solid #e5e5e5",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <p style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>
            Q: {searchParams.question}
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{searchParams.answer}</p>
        </div>
      )}

      <h3 style={{ marginTop: 32 }}>Uploaded documents</h3>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: "#fff",
          marginTop: 8,
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e5e5" }}>
            <th style={thStyle}>Title</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((d) => (
            <tr key={d.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={tdStyle}>{d.title}</td>
              <td style={tdStyle}>{d.status}</td>
              <td style={tdStyle}>{d.createdAt.toLocaleDateString()}</td>
            </tr>
          ))}
          {documents.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={3}>
                No documents yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const inputStyle = {
  padding: 8,
  border: "1px solid #ccc",
  borderRadius: 6,
};
const buttonStyle = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
const thStyle = { padding: "10px 12px", fontSize: 13, color: "#666" };
const tdStyle = { padding: "10px 12px", fontSize: 14 };
