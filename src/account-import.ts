import type { BankAccount } from "./bank_accounts.ts";
import { escapeHtml } from "./html-utils.ts";
export { initializeManualAccountCreation, initializeAccountImport, readTransactionFile } from "./account-import-workflow.ts";

export function renderManualAccountDialog(): string {
  return `<dialog id="manual-account-dialog" class="account-workflow-dialog" aria-labelledby="manual-account-title">
    <form id="manual-account-form" class="account-workflow">
      <header><p class="eyebrow">MANUAL ACCOUNT</p><h2 id="manual-account-title">Add an account</h2><p>No bank connection or credentials needed.</p></header>
      <div class="account-workflow-body">
        <label class="form-field"><span>Account name</span><input name="name" required maxlength="100" placeholder="Everyday Checking" autocomplete="off"></label>
        <label class="form-field"><span>Institution name</span><input name="institutionName" required maxlength="100" placeholder="Your bank or brokerage" autocomplete="off"></label>
        <div class="account-form-grid">
          <label class="form-field"><span>Account type</span><select name="accountKind"><option value="depository:checking">Checking</option><option value="depository:savings">Savings</option><option value="credit:credit card">Credit card</option><option value="investment:brokerage">Brokerage</option><option value="loan:loan">Loan</option><option value="depository:other">Other cash account</option></select></label>
          <label class="form-field"><span>Currency</span><input name="currencyCode" value="USD" required pattern="[A-Za-z]{3}" maxlength="3" autocomplete="off"></label>
          <label class="form-field"><span>Last four digits (optional)</span><input name="mask" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="1234" autocomplete="off"><small>Used to recognize account references and transfers.</small></label>
          <label class="form-field"><span>Current balance (optional)</span><input name="currentBalance" type="number" step="0.01" placeholder="0.00"><small>For credit cards and loans, enter the amount owed.</small></label>
        </div>
        <p class="account-workflow-note">This balance is a manual snapshot, not changed by transaction imports. Importing historical activity will not double-count your balance.</p>
      </div>
      <p id="manual-account-error" class="auth-message error" role="alert" hidden></p>
      <footer class="account-workflow-actions"><button id="cancel-manual-account" class="secondary-button" type="button">Cancel</button><button class="primary-button" type="submit">Create account</button></footer>
    </form>
  </dialog>`;
}

export function renderImportDialog(account: BankAccount): string {
  return `<dialog id="account-import-dialog" class="account-workflow-dialog import-workflow-dialog" aria-labelledby="account-import-title">
    <form id="account-import-form" class="account-workflow">
      <header><p class="eyebrow">TRANSACTION IMPORT</p><h2 id="account-import-title">Import transactions</h2><p>${escapeHtml(account.institutionName)} · ${escapeHtml(account.name)} · ${escapeHtml(account.currencyCode ?? "USD")}</p></header>
      <div class="account-workflow-body">
        <section id="import-file-step">
          <label class="form-field"><span>Transaction file</span><input id="import-file" type="file" accept=".csv,.ofx,.qfx" required><small>CSV, OFX, or QFX · up to 4 MB. Nothing is saved until you confirm the preview.</small></label>
          <div id="import-csv-options">
            <div class="account-form-grid">
              <label class="form-field"><span>CSV date format</span><select id="import-date-format"><option value="mdy">Month / day / year</option><option value="dmy">Day / month / year</option><option value="ymd">Year / month / day</option></select></label>
              <label class="form-field"><span>CSV signed amounts</span><select id="import-amount-convention"><option value="inflow-positive">Positive = money in</option><option value="outflow-positive">Positive = money out</option></select></label>
            </div>
            <p class="account-workflow-hint">Choose the conventions used in your export. Separate debit/credit columns and OFX/QFX amounts are handled automatically.</p>
            <fieldset id="import-column-mapping" hidden><legend>CSV columns</legend><p>Check the suggested columns or choose your own. Use one signed amount column, or separate debit and credit columns.</p><div id="import-mapping-fields" class="account-form-grid"></div></fieldset>
          </div>
          <p class="account-workflow-note">Keep full descriptions and add the last four digits to your accounts so existing transfer recognition can match references. Overlapping files without transaction IDs are matched by date, description, amount, and occurrence count.</p>
        </section>
        <section id="import-preview-step" hidden><p id="import-preview-summary" class="account-workflow-note"></p><p>Check the signs: <strong>− is money out</strong>, <strong>+ is money in</strong>. Your account balance will not change.</p><div class="import-preview-table-wrap"><table class="import-preview-table"><thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Amount</th></tr></thead><tbody id="import-preview-rows"></tbody></table></div><p id="import-preview-limit" class="account-workflow-hint"></p></section>
      </div>
      <p id="account-import-error" class="auth-message error" role="alert" hidden></p>
      <footer class="account-workflow-actions"><button id="import-back" class="secondary-button" type="button">Cancel</button><button id="import-next" class="primary-button" type="submit">Preview transactions</button></footer>
    </form>
  </dialog>`;
}
