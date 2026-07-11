import { MessageSquare } from "lucide-react";

export const dynamic = "force-dynamic";

export default function ConversationsIndexPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <MessageSquare className="text-gray-300" size={40} />
      <p className="mt-3 text-sm font-medium text-gray-700">Select a conversation to continue</p>
      <p className="mt-1 text-xs text-gray-400">Choose a client from the list on the left.</p>
    </div>
  );
}
