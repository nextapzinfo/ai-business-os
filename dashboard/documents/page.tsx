import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";

export default async function DocumentsPage() {
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
        Document upload + AI question-answering (RAG) is built in Phase 2.
        This page will list uploaded GST/Income Tax reference documents.
      </p>

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: "#fff",
          marginTop: 16,
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

const thStyle = { padding: "10px 12px", fontSize: 13, color: "#666" };
const tdStyle = { padding: "10px 12px", fontSize: 14 };
