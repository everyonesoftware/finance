import type { BankAccount } from "./bank_accounts.ts";
import { escapeHtml } from "./html-utils.ts";

export interface BalanceImpact {
  referenceBalance: number | null;
  referenceDate: string | null;
  startingBalance: number | null;
  historicalCount: number;
  appliedCount: number;
  appliedAmount: number;
  duplicates: number;
  balanceAfterImport: number | null;
  canApply: boolean;
  reason?: string;
}

export function localBalanceDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function currency(value: number | null, code: string, signed = false): string {
  if (value === null) return "Not set";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code, ...(signed ? { signDisplay: "exceptZero" as const } : {}) }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

export function renderBalanceFields(code: string, amount = 0, date = localBalanceDate(), owed = false): string {
  return `<div class="account-form-grid balance-reference-fields">
    <label class="form-field"><span>${owed ? "Amount owed" : "Balance"} (${escapeHtml(code)})</span><input name="currentBalance" type="number" step="0.01" value="${escapeHtml(amount.toFixed(2))}" required></label>
    <label class="form-field"><span>End of day</span><input name="balanceDate" type="date" value="${escapeHtml(date)}" max="${localBalanceDate()}" required></label>
  </div><p class="balance-reference-hint">You can adjust the balance after importing transactions.</p>`;
}

export function renderBalanceImpact(impact: BalanceImpact, code: string, label?: string): string {
  const row = (title: string, amount: string, detail = "", total = false) => `<div class="balance-impact-row${total ? " balance-impact-total" : ""}"><dt>${escapeHtml(title)}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</dt><dd>${escapeHtml(amount)}</dd></div>`;
  const referenceDate = impact.referenceDate ?? "Not set";
  const referenceAmount = impact.referenceBalance;
  const existing = impact.startingBalance === null || referenceAmount === null ? null : Math.round((impact.startingBalance - referenceAmount) * 100) / 100;
  return `<section class="balance-impact" aria-label="Balance after import${label ? ` · ${escapeHtml(label)}` : ""}">
    <h3>Balance after import</h3>${label ? `<p class="balance-impact-label">${escapeHtml(label)}</p>` : ""}
    ${impact.reason ? `<p class="account-workflow-note">${escapeHtml(impact.reason)}</p>` : ""}
    <dl>
      ${impact.referenceDate ? row(`Reference balance · ${referenceDate}`, currency(referenceAmount, code), "End of day") : row("Balance before import", currency(impact.startingBalance, code), "No dated reference set")}
      ${existing !== null && existing !== 0 ? row("Previously imported later activity", currency(existing, code, true), "Already reflected in your balance") : ""}
      ${impact.canApply ? row(`${impact.historicalCount} new transaction${impact.historicalCount === 1 ? "" : "s"} through ${referenceDate}`, "No change", "Already included in the reference balance") : ""}
      ${impact.canApply ? row(`${impact.appliedCount} new later transaction${impact.appliedCount === 1 ? "" : "s"}`, currency(impact.appliedAmount, code, true), "Changes your balance") : row("Transaction imports", "No change", "No automatic balance update")}
      ${row(`${impact.duplicates} duplicate${impact.duplicates === 1 ? "" : "s"}`, currency(0, code), "Skipped · no balance impact")}
      ${row("Balance after import", currency(impact.balanceAfterImport, code), "", true)}
    </dl>
    <p class="balance-reference-hint">You can adjust the balance after importing transactions.</p>
  </section>`;
}

export function renderAccountBalanceDialog(account: BankAccount): string {
  return `<dialog id="account-balance-dialog" class="account-workflow-dialog account-balance-dialog" aria-labelledby="account-balance-title">
    <form id="account-balance-form" class="account-workflow">
      <header><p class="eyebrow">MANUAL ACCOUNT</p><h2 id="account-balance-title">Set balance</h2><p>${escapeHtml(account.name)}</p></header>
      <div class="account-workflow-body">${renderBalanceFields(account.currencyCode ?? "USD", account.currentBalance ?? 0, localBalanceDate(), account.type === "credit" || account.type === "loan")}</div>
      <p id="account-balance-error" class="auth-message error" role="alert" hidden></p>
      <footer class="account-workflow-actions"><button id="cancel-account-balance" class="secondary-button" type="button">Cancel</button><button id="save-account-balance" class="primary-button" type="submit">Save balance</button></footer>
    </form>
  </dialog>`;
}

export function initializeAccountBalance(account: BankAccount, onSaved: (account: BankAccount) => Promise<void>, signal?: AbortSignal): void {
  const dialog = document.querySelector<HTMLDialogElement>("#account-balance-dialog");
  const form = document.querySelector<HTMLFormElement>("#account-balance-form");
  const error = document.querySelector<HTMLElement>("#account-balance-error");
  const cancel = document.querySelector<HTMLButtonElement>("#cancel-account-balance");
  const submit = document.querySelector<HTMLButtonElement>("#save-account-balance");
  const trigger = document.querySelector<HTMLButtonElement>("#set-account-balance");
  if (!dialog || !form || !submit || !cancel || !trigger) return;
  const active = () => !signal?.aborted && dialog.isConnected !== false && form.isConnected !== false;
  let busy = false;
  const showError = (message = "") => { if (error) { error.textContent = message; error.hidden = !message; } };
  trigger.addEventListener("click", () => { if (active() && !busy) { showError(); dialog.showModal(); } });
  cancel.addEventListener("click", () => { if (active() && !busy) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!active() || busy) return;
    const data = new FormData(form);
    busy = true;
    submit.disabled = cancel.disabled = true;
    for (const control of form.querySelectorAll<HTMLInputElement>("input")) control.disabled = true;
    showError();
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/balance`, {
        method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentBalance: Number(data.get("currentBalance")), balanceDate: String(data.get("balanceDate") ?? "") }),
      });
      const result = await response.json();
      if (!active()) return;
      if (!response.ok || !result?.account) throw new Error(result?.error ?? "Unable to save the balance. Please try again.");
      dialog.close();
      await onSaved(result.account);
    } catch (cause) {
      if (active()) showError(cause instanceof Error ? cause.message : "Unable to save the balance.");
    } finally {
      busy = false;
      if (active()) {
        submit.disabled = cancel.disabled = false;
        for (const control of form.querySelectorAll<HTMLInputElement>("input")) control.disabled = false;
      }
    }
  });
}
