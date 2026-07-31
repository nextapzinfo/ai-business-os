import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { formatDate } from "@/lib/formatDate";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";

async function addOrder(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const clientId = formData.get("clientId") as string;
  const items = (formData.get("items") as string)?.trim();
  const deliveryAddress = (formData.get("deliveryAddress") as string)?.trim() || undefined;
  const note = (formData.get("note") as string)?.trim() || undefined;
  if (!clientId || !items) return;

  // Confirm the client actually belongs to this org before attaching an order —
  // never trust a form-submitted clientId on its own (tenant isolation "forbidden rule").
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId: user.organizationId },
  });
  if (!client) return;

  const order = await prisma.order.create({
    data: {
      organizationId: user.organizationId,
      clientId,
      items,
      deliveryAddress,
      note,
      status: "PENDING",
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "ORDER_CREATED",
    metadata: { orderId: order.id, clientId, items },
  });

  revalidatePath("/dashboard/orders");
}

async function updateOrderStatus(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const orderId = formData.get("orderId") as string;
  const status = formData.get("status") as string;
  if (!orderId || !status) return;

  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId: user.organizationId },
  });
  if (!order) return;

  await prisma.order.update({ where: { id: orderId }, data: { status } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "ORDER_STATUS_UPDATED",
    metadata: { orderId, status },
  });

  revalidatePath("/dashboard/orders");
}

// Manual, staff-set payment status — there's no payment gateway wired up yet
// (see the Billing/Razorpay build plan for the future automated path). Staff
// checks a customer's payment screenshot (now visible in Conversations, see
// the image-handling fix) and flips this themselves.
async function togglePaymentStatus(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const orderId = formData.get("orderId") as string;
  if (!orderId) return;

  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId: user.organizationId },
  });
  if (!order) return;

  const nextStatus = order.paymentStatus === "PAID" ? "UNPAID" : "PAID";
  await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: nextStatus } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "ORDER_PAYMENT_STATUS_UPDATED",
    metadata: { orderId, paymentStatus: nextStatus },
  });

  revalidatePath("/dashboard/orders");
}

function paymentBadgeClass(paymentStatus: string) {
  return paymentStatus === "PAID" ? "bg-accent-light text-accent" : "bg-gray-100 text-gray-500";
}

function statusBadgeClass(status: string) {
  if (status === "FULFILLED") return "bg-accent-light text-accent";
  if (status === "CONFIRMED") return "bg-sky-100 text-sky-700";
  if (status === "CANCELLED") return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-700"; // PENDING
}

export default async function OrdersPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [orders, clients] = await Promise.all([
    prisma.order.findMany({
      where: { organizationId: user.organizationId },
      include: { client: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.client.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Orders</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Orders the AI records on WhatsApp (once it has confirmed items and delivery details with the
        customer), or that you add manually below. Prices aren't tracked here — confirm the total with the
        customer yourself before marking an order Confirmed.
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add an order</h3>
        <form action={addOrder} className="mt-3 flex flex-wrap gap-2">
          <select
            name="clientId"
            required
            className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"
          >
            <option value="">Select client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            name="items"
            placeholder="e.g. 2kg Mishti Doi, 1kg Ghee"
            required
            className="flex-1 basis-56 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            name="deliveryAddress"
            placeholder="Delivery address (optional)"
            className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            name="note"
            placeholder="Note (optional)"
            className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Add Order
          </button>
        </form>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Items</th>
              <th className="px-4 py-3 font-medium">Delivery</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Payment</th>
              <th className="px-4 py-3 font-medium">Placed</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-gray-50 last:border-0 align-top">
                <td className="px-4 py-3 font-medium text-gray-900">{o.client.name}</td>
                <td className="px-4 py-3 text-gray-600">
                  <span className="whitespace-pre-line">{o.items}</span>
                  {o.note && <p className="mt-0.5 text-xs text-gray-400">{o.note}</p>}
                  {o.totalAmount != null && (
                    <p className="mt-1 text-xs font-medium text-gray-700">
                      Total: ৳{o.totalAmount}{" "}
                      <span className="font-normal text-gray-400">
                        (Sub ৳{o.subtotal} + Ship ৳{o.shippingCharge})
                      </span>
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">{o.deliveryAddress || "Pickup / not given"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(o.status)}`}>
                    {o.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <form action={togglePaymentStatus}>
                    <input type="hidden" name="orderId" value={o.id} />
                    <button
                      type="submit"
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${paymentBadgeClass(o.paymentStatus)}`}
                      title="Click to toggle after checking the customer's payment screenshot"
                    >
                      {o.paymentStatus}
                    </button>
                  </form>
                </td>
                <td className="px-4 py-3 text-gray-500">{formatDate(o.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {o.status === "PENDING" && (
                      <form action={updateOrderStatus}>
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="status" value="CONFIRMED" />
                        <button type="submit" className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
                          Confirm
                        </button>
                      </form>
                    )}
                    {o.status === "CONFIRMED" && (
                      <form action={updateOrderStatus}>
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="status" value="FULFILLED" />
                        <button type="submit" className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
                          Mark Fulfilled
                        </button>
                      </form>
                    )}
                    {(o.status === "PENDING" || o.status === "CONFIRMED") && (
                      <form action={updateOrderStatus}>
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="status" value="CANCELLED" />
                        <ConfirmSubmitButton
                          label="Cancel"
                          confirmText={`Cancel this order for ${o.client.name}?`}
                          className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                        />
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-gray-500" colSpan={7}>
                  No orders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
