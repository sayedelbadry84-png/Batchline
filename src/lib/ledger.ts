import type { Prisma } from "@prisma/client";
import { withSequentialNumber } from "@/lib/sequence";

// Every function here takes its Prisma client as the first argument rather
// than importing the module-level singleton directly — the caller is
// expected to pass a transaction handle (prisma.$transaction(async (tx) =>
// ...)) that also created/updated the source record (Invoice, Payment,
// SupplierBill, ...) in the same call, so the two can never diverge: either
// both commit or neither does. A caller who genuinely has no source record
// of its own to wrap (there currently isn't one) could still pass the
// plain `prisma` singleton — Prisma.TransactionClient's shape is a subset
// of PrismaClient's, so it's accepted too — but every real event in this
// app posts inside its own transaction; see billing/actions.ts,
// finance/actions.ts, and employees/payroll/actions.ts for the call sites.
type Db = Prisma.TransactionClient;

type AccountRef = { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" };

// The whole chart of accounts for this first version — small, fixed, and
// self-seeded on first use (see ensureAccount) rather than user-editable;
// a real chart-of-accounts management screen is a separate later feature.
export const ACCOUNTS = {
  CASH: { code: "1000", name: "Cash", type: "ASSET" },
  AR: { code: "1100", name: "Accounts Receivable", type: "ASSET" },
  AP: { code: "2000", name: "Accounts Payable", type: "LIABILITY" },
  TAX_PAYABLE: { code: "2100", name: "Tax Payable", type: "LIABILITY" },
  OWNER_EQUITY: { code: "3000", name: "Owner's Equity", type: "EQUITY" },
  REVENUE: { code: "4000", name: "Sales Revenue", type: "REVENUE" },
  OTHER_INCOME: { code: "4100", name: "Other Income", type: "REVENUE" },
  SALES_RETURNS: { code: "4900", name: "Sales Returns & Allowances", type: "REVENUE" },
  COGS_MATERIALS: { code: "5000", name: "Cost of Materials & Supplier Bills", type: "EXPENSE" },
  PAYROLL_EXPENSE: { code: "5100", name: "Payroll Expense", type: "EXPENSE" },
  OPERATING_EXPENSE: { code: "5200", name: "Operating Expense", type: "EXPENSE" },
  UTILITIES_EXPENSE: { code: "5300", name: "Utilities Expense", type: "EXPENSE" },
  FUEL_EXPENSE: { code: "5400", name: "Fuel Expense", type: "EXPENSE" },
  MAINTENANCE_EXPENSE: { code: "5500", name: "Maintenance Expense", type: "EXPENSE" },
  OTHER_EXPENSE: { code: "5900", name: "Other Expense", type: "EXPENSE" },
} as const satisfies Record<string, AccountRef>;

// CashTransaction.category -> which account sits on the non-cash side of
// the entry (see postCashTransaction). Revenue-type accounts are credited
// on an IN, expense/equity-type accounts are debited on an OUT — see
// postCashTransaction for the actual direction logic.
export const CASH_CATEGORY_ACCOUNT: Record<string, AccountRef> = {
  OPERATING_EXPENSE: ACCOUNTS.OPERATING_EXPENSE,
  PAYROLL: ACCOUNTS.PAYROLL_EXPENSE,
  END_OF_SERVICE: ACCOUNTS.PAYROLL_EXPENSE,
  UTILITIES: ACCOUNTS.UTILITIES_EXPENSE,
  FUEL: ACCOUNTS.FUEL_EXPENSE,
  MAINTENANCE: ACCOUNTS.MAINTENANCE_EXPENSE,
  OTHER_INCOME: ACCOUNTS.OTHER_INCOME,
  OWNER_CONTRIBUTION: ACCOUNTS.OWNER_EQUITY,
  OTHER: ACCOUNTS.OTHER_EXPENSE,
};

async function ensureAccount(db: Db, ref: AccountRef): Promise<string> {
  const account = await db.account.upsert({ where: { code: ref.code }, create: ref, update: {} });
  return account.id;
}

/**
 * The one entry point every real financial event posts through — see
 * JournalEntry's model comment in schema.prisma for the engine's overall
 * shape (additive, alongside the existing Billing/Finance/Payroll models,
 * never replacing them). Throws on an unbalanced entry rather than
 * silently posting bad books — every caller here is expected to pass
 * lines that already balance by construction (see e.g. postInvoice
 * below), so a mismatch means a real bug in the caller, not a stray
 * amount to be tolerated.
 */
export async function postJournalEntry(
  db: Db,
  params: {
    siteId: string;
    currency: string;
    sourceModule: string;
    sourceRecordId: string;
    memo?: string;
    lines: { account: AccountRef; debit?: number; credit?: number }[];
  },
): Promise<void> {
  const totalDebit = params.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0);
  const totalCredit = params.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Unbalanced journal entry for ${params.sourceModule}/${params.sourceRecordId}: debit ${totalDebit} != credit ${totalCredit}`);
  }

  const accountIds = await Promise.all(params.lines.map((l) => ensureAccount(db, l.account)));

  await withSequentialNumber(
    "JE",
    () => db.journalEntry.count(),
    (entryNumber) =>
      db.journalEntry.create({
        data: {
          entryNumber,
          siteId: params.siteId,
          currency: params.currency,
          sourceModule: params.sourceModule,
          sourceRecordId: params.sourceRecordId,
          memo: params.memo,
          lines: {
            create: params.lines.map((l, i) => ({ accountId: accountIds[i], debit: l.debit ?? 0, credit: l.credit ?? 0, siteId: params.siteId, currency: params.currency })),
          },
        },
      }),
  );
}

/**
 * Posts a reversing entry for whatever was originally posted under this
 * sourceModule/sourceRecordId — every debit becomes a credit and vice
 * versa, same amounts, so the two entries net to zero on the Trial
 * Balance. Never mutates or deletes the original entry (same
 * never-rewrite-history posture as every other document in this app) —
 * this is the standard double-entry way to undo a posting. A no-op if
 * nothing was ever posted for this record (e.g. an Invoice with no
 * plantId, which postInvoice's own callers already skip).
 */
export async function reverseJournalEntry(db: Db, sourceModule: string, sourceRecordId: string, memo?: string): Promise<void> {
  const original = await db.journalEntry.findFirst({ where: { sourceModule, sourceRecordId }, include: { lines: true } });
  if (!original) return;

  await withSequentialNumber(
    "JE",
    () => db.journalEntry.count(),
    (entryNumber) =>
      db.journalEntry.create({
        data: {
          entryNumber,
          siteId: original.siteId,
          currency: original.currency,
          sourceModule,
          sourceRecordId,
          memo: memo ?? `Reversal of ${original.entryNumber}`,
          lines: { create: original.lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, siteId: original.siteId, currency: original.currency })) },
        },
      }),
  );
}

// --- One small poster per real financial event, called right after the
// event's own existing create/update — see billing/actions.ts,
// finance/actions.ts, and employees/payroll/actions.ts for the call
// sites. Each is a thin, self-explanatory wrapper around
// postJournalEntry; kept here so the accounting logic lives in one place
// rather than scattered across every module's own actions file. Every
// call site passes the same `tx` it used to create/update the source
// record, inside one prisma.$transaction — see the Db type note above. ---

export async function postInvoice(db: Db, params: { siteId: string; currency: string; invoiceId: string; subtotal: number; taxAmount: number; total: number }): Promise<void> {
  const lines: { account: AccountRef; debit?: number; credit?: number }[] = [
    { account: ACCOUNTS.AR, debit: params.total },
    { account: ACCOUNTS.REVENUE, credit: params.subtotal },
  ];
  if (params.taxAmount > 0) lines.push({ account: ACCOUNTS.TAX_PAYABLE, credit: params.taxAmount });
  await postJournalEntry(db, { siteId: params.siteId, currency: params.currency, sourceModule: "Billing", sourceRecordId: params.invoiceId, memo: "Invoice issued", lines });
}

export async function postPayment(db: Db, params: { siteId: string; currency: string; paymentId: string; amount: number }): Promise<void> {
  await postJournalEntry(db, {
    siteId: params.siteId,
    currency: params.currency,
    sourceModule: "Billing",
    sourceRecordId: params.paymentId,
    memo: "Customer payment received",
    lines: [{ account: ACCOUNTS.CASH, debit: params.amount }, { account: ACCOUNTS.AR, credit: params.amount }],
  });
}

export async function postCreditNote(db: Db, params: { siteId: string; currency: string; creditNoteId: string; amount: number }): Promise<void> {
  await postJournalEntry(db, {
    siteId: params.siteId,
    currency: params.currency,
    sourceModule: "Billing",
    sourceRecordId: params.creditNoteId,
    memo: "Credit note issued",
    lines: [{ account: ACCOUNTS.SALES_RETURNS, debit: params.amount }, { account: ACCOUNTS.AR, credit: params.amount }],
  });
}

export async function postSupplierBill(db: Db, params: { siteId: string; currency: string; billId: string; total: number }): Promise<void> {
  await postJournalEntry(db, {
    siteId: params.siteId,
    currency: params.currency,
    sourceModule: "Finance",
    sourceRecordId: params.billId,
    memo: "Supplier bill received",
    lines: [{ account: ACCOUNTS.COGS_MATERIALS, debit: params.total }, { account: ACCOUNTS.AP, credit: params.total }],
  });
}

export async function postSupplierPayment(db: Db, params: { siteId: string; currency: string; paymentId: string; amount: number }): Promise<void> {
  await postJournalEntry(db, {
    siteId: params.siteId,
    currency: params.currency,
    sourceModule: "Finance",
    sourceRecordId: params.paymentId,
    memo: "Supplier payment made",
    lines: [{ account: ACCOUNTS.AP, debit: params.amount }, { account: ACCOUNTS.CASH, credit: params.amount }],
  });
}

// direction "IN": cash comes in, the category account (revenue/equity)
// gets credited. direction "OUT": cash goes out, the category account
// (an expense, normally) gets debited. Same "IN/OUT" vocabulary
// CashTransaction.direction already uses.
export async function postCashTransaction(db: Db, params: { siteId: string; currency: string; txnId: string; direction: "IN" | "OUT"; category: string; amount: number; description: string }): Promise<void> {
  const categoryAccount = CASH_CATEGORY_ACCOUNT[params.category] ?? ACCOUNTS.OTHER_EXPENSE;
  const lines =
    params.direction === "IN"
      ? [{ account: ACCOUNTS.CASH, debit: params.amount }, { account: categoryAccount, credit: params.amount }]
      : [{ account: categoryAccount, debit: params.amount }, { account: ACCOUNTS.CASH, credit: params.amount }];
  await postJournalEntry(db, { siteId: params.siteId, currency: params.currency, sourceModule: "Finance", sourceRecordId: params.txnId, memo: params.description, lines });
}
