const CURRENCY = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// Same "X cr" shorthand the stats strip uses, for other large rupee totals
// (the district map) where a full rupee figure would be unreadable.
export function formatCr(amountRupees) {
  return `₹${(amountRupees / 1e7).toFixed(2)} cr`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" });

// "2026-09-19" -> "19 September 2026", for dates read from the data
// (last_built, order_date) rather than a citation someone typed by hand.
export function formatDate(isoDate) {
  if (!isoDate) return null;
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return DATE_FORMAT.format(parsed);
}

// An amount can be a settled figure, a rate with no settled figure ("18%
// p.a."), both, or genuinely nothing the order states -- see schema.json's
// `amount` definition. Render whichever parts exist rather than assuming a
// number is always there.
export function formatAmount(amount) {
  if (!amount) return null;
  const parts = [];
  if (amount.value != null) parts.push(CURRENCY.format(amount.value));
  if (amount.interest_rate_description) parts.push(`interest at ${amount.interest_rate_description}`);
  if (parts.length === 0) return null;
  return parts.join(" + ") + (amount.recipient === "government" ? " (to government)" : "");
}
