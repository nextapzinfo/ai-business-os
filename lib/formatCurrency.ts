export function formatInr(amountInr: number): string {
  return amountInr.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  });
}
