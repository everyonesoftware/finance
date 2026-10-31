import type { BankAccount } from "./bank_accounts.ts";
import { escapeHtml } from "./html-utils.ts";

interface TransactionAccountMention {
  start: number;
  end: number;
  account: BankAccount;
}

function getTransactionAccountMentions(
  name: string,
  accounts: BankAccount[],
): TransactionAccountMention[] {
  const candidates: TransactionAccountMention[] = [];
  for (const account of accounts) {
    const mask = account.mask?.replace(/\D/g, "");
    if (!mask) continue;
    const aliases = new Set(
      [account.name, account.officialName, account.subtype]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    );
    aliases.add("account");

    for (const alias of aliases) {
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const permitsAccountSuffix = !/\baccount$/i.test(alias);
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapedAlias}${permitsAccountSuffix ? "(?:\\s+account)?" : ""}\\s*(?:ending\\s*(?:in\\s*)?)?(?:x{2,}|\\*{2,}|…)?\\s*${mask}(?!\\d)`,
        "giu",
      );
      for (const match of name.matchAll(pattern)) {
        if (match.index !== undefined) {
          let start = match.index;
          if (alias.toLowerCase() === "account") {
            const prefix = name.slice(0, start);
            const boundary = [...prefix.matchAll(/\b(?:to|from)\s+/gi)].at(-1);
            if (boundary?.index !== undefined) start = boundary.index + boundary[0].length;
          }
          candidates.push({ start, end: match.index + match[0].length, account });
        }
      }
    }
  }
  return candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
}

export function findReferencedAccount(name: string, accounts: BankAccount[]): BankAccount | null {
  return getTransactionAccountMentions(name, accounts)[0]?.account ?? null;
}

export function renderLinkedTransactionName(name: string, accounts: BankAccount[]): string {
  const candidates = getTransactionAccountMentions(name, accounts);
  let result = "";
  let lastIndex = 0;
  for (const candidate of candidates) {
    if (candidate.start < lastIndex) continue;
    result += escapeHtml(name.slice(lastIndex, candidate.start));
    result += `<a class="transaction-account-link" href="/accounts/${escapeHtml(encodeURIComponent(candidate.account.id))}">${escapeHtml(name.slice(candidate.start, candidate.end))}</a>`;
    lastIndex = candidate.end;
  }
  result += escapeHtml(name.slice(lastIndex));
  return result;
}

export function formatTransactionAmount(amount: number, currencyCode: string | null): string {
  if (!Number.isFinite(amount)) {
    return "—";
  }

  // Plaid uses positive values for outflows and negative values for inflows;
  // invert the sign for a familiar account-ledger presentation.
  const displayedAmount = -amount;
  if (currencyCode && /^[A-Z]{3}$/.test(currencyCode)) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currencyCode,
      }).format(displayedAmount);
    } catch {
      // Fall back to a plain numeric amount if Intl rejects the currency.
    }
  }

  return `${displayedAmount < 0 ? "-" : ""}${Math.abs(displayedAmount).toFixed(2)}`;
}
