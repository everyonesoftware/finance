import type { BankAccount } from "./bank_accounts.ts";
import { escapeHtml } from "./html-utils.ts";

export function renderAccountDeleteDialog(account: BankAccount): string {
  const type = account.type === "credit" && account.subtype === "credit card" ? "Credit card" : "Account";
  const identity = account.mask ? `${type} ending in ${account.mask}` : `${type} number hidden`;
  const records = account.type === "investment" ? "saved transactions, balance history, and holdings snapshots" : "saved transactions and balance history";
  return `<dialog id="account-delete-dialog" class="account-workflow-dialog account-delete-dialog" aria-labelledby="account-delete-title" aria-describedby="account-delete-identity account-delete-warning">
    <div class="account-delete-body">
      <header class="account-delete-heading">
        <span class="account-delete-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg></span>
        <h2 id="account-delete-title">Delete account?</h2>
      </header>
      <p class="account-delete-identity" id="account-delete-identity"><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.institutionName)} · ${escapeHtml(identity)}</span></p>
      <p class="account-delete-warning" id="account-delete-warning">This removes the account and its ${records} from Finance. It does not close your ${type === "Credit card" ? "card" : "account"} with ${escapeHtml(account.institutionName)}.<strong>This can’t be undone.</strong></p>
      <p id="account-delete-error" class="auth-message error" role="alert" hidden></p>
    </div>
    <footer class="account-delete-actions">
      <button class="secondary-button" id="cancel-account-delete" type="button" autofocus>Cancel</button>
      <button class="primary-button account-delete-confirm" id="confirm-account-delete" type="button">Delete account</button>
    </footer>
  </dialog>`;
}

export function initializeAccountDelete(container: HTMLElement, account: BankAccount, onDeleted: () => void, signal?: AbortSignal): void {
  const query = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#${id}`);
  const dialog = query<HTMLDialogElement>("account-delete-dialog");
  const menu = query<HTMLElement>("account-balance-menu");
  const options = query<HTMLButtonElement>("account-balance-options");
  const trigger = query<HTMLButtonElement>("delete-account");
  const cancel = query<HTMLButtonElement>("cancel-account-delete");
  const confirm = query<HTMLButtonElement>("confirm-account-delete");
  const error = query<HTMLParagraphElement>("account-delete-error");
  if (!dialog || !menu || !options || !trigger || !cancel || !confirm || !error) return;
  const active = () => !signal?.aborted && dialog.isConnected;
  const showError = (message = "") => { error.textContent = message; error.hidden = !message; };
  let busy = false;

  trigger.addEventListener("click", () => {
    if (!active() || busy || dialog.open) return;
    menu.hidePopover();
    showError();
    dialog.showModal();
  });
  cancel.addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (active() && !dialog.open) options.focus(); });
  confirm.addEventListener("click", async () => {
    if (!active() || !dialog.open || busy) return;
    busy = true;
    confirm.disabled = cancel.disabled = true;
    confirm.textContent = "Deleting…";
    showError();
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/deletion`, {
        method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!active()) return;
      if (!response.ok) {
        throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Unable to delete the account.");
      }
      if (!result || typeof result !== "object" || !("deleted" in result) || result.deleted !== true) {
        throw new Error("Deletion could not be verified. Check the Accounts list before trying again.");
      }
      dialog.close();
      onDeleted();
    } catch (cause) {
      if (active()) showError(cause instanceof Error && cause.name !== "TypeError"
        ? cause.message : "Deletion could not be verified. Check the Accounts list before trying again.");
    } finally {
      busy = false;
      if (active()) {
        confirm.disabled = cancel.disabled = false;
        confirm.textContent = "Delete account";
        if (dialog.open) cancel.focus();
      }
    }
  });
}
