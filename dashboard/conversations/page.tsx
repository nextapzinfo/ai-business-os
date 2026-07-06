import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";

export default async function ConversationsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const conversations = await prisma.conversation.findMany({
    where: { organizationId: user.organizationId },
    include: {
      client: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1>Conversations</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        WhatsApp conversations will populate here automatically once Phase 3
        (direct Meta Cloud API integration) is connected.
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
            <th style={thStyle}>Client</th>
            <th style={thStyle}>Channel</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Last Message</th>
          </tr>
        </thead>
        <tbody>
          {conversations.map((c) => (
            <tr key={c.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={tdStyle}>{c.client.name}</td>
              <td style={tdStyle}>{c.channel}</td>
              <td style={tdStyle}>{c.status}</td>
              <td style={tdStyle}>{c.messages[0]?.content ?? "-"}</td>
            </tr>
          ))}
          {conversations.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={4}>
                No conversations yet.
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
