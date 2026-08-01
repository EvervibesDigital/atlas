export interface BuyerRow {
  name: string;
  company: string;
  email: string;
  phone: string;
  mailingAddress: string;
  states: string;
  strategy: string;
  source: string;
}

export interface BuyerStats {
  total: number;
  withEmail: number;
  withPhone: number;
  withMailingAddress: number;
  /** How many `send-intro` could actually reach (it requires an email). */
  emailable: number;
  /** How many `find-and-trace-top` could work from (it traces via mailing address). */
  traceable: number;
  bySource: Record<string, number>;
}

/**
 * Minimal RFC4180-ish CSV parser — handles quoted fields containing commas
 * and escaped double-quotes, which naive `split(",")` mangles. Buyer names and
 * addresses routinely contain commas ("Smith, LLC"), so this matters: a naive
 * split silently shifts every later column and corrupts the fill-rate counts
 * this module exists to report.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else if (c !== "\r") field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const filled = (v: string | undefined): boolean => (v ?? "").trim().length > 2;

/** Maps the CSV from `/api/wholesale/buyers/export` into typed rows. Column
 * order is read from the header, not assumed positionally. */
export function toBuyerRows(csv: string): BuyerRow[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const at = (r: string[], name: string): string => {
    const i = header.indexOf(name);
    return i >= 0 ? (r[i] ?? "").trim() : "";
  };
  return rows.slice(1).map((r) => ({
    name: at(r, "name"),
    company: at(r, "company"),
    email: at(r, "email"),
    phone: at(r, "phone"),
    mailingAddress: at(r, "mailing address"),
    states: at(r, "states"),
    strategy: at(r, "strategy"),
    source: at(r, "source"),
  }));
}

/**
 * Contact-coverage stats. This is the number that actually decides what's
 * worth doing: measured live 2026-08-01 across 1,791 real buyers, only 70 had
 * an email and just 2 had a mailing address — so `send-intro` has ~70 reachable
 * people while `find-and-trace-top` (which traces FROM a mailing address) has
 * almost nothing to work with. Report it before acting, don't assume.
 */
export function buyerStats(rows: BuyerRow[]): BuyerStats {
  const bySource: Record<string, number> = {};
  let withEmail = 0;
  let withPhone = 0;
  let withMailingAddress = 0;

  for (const r of rows) {
    if (filled(r.email)) withEmail++;
    if (filled(r.phone)) withPhone++;
    if (filled(r.mailingAddress)) withMailingAddress++;
    const src = r.source.trim() || "(unknown)";
    bySource[src] = (bySource[src] ?? 0) + 1;
  }

  return {
    total: rows.length,
    withEmail,
    withPhone,
    withMailingAddress,
    emailable: withEmail,
    traceable: withMailingAddress,
    bySource,
  };
}
