import { appVersion } from "./app-version.ts";
import { renderMainNavigation } from "./navigation.ts";

export interface DashboardUser {
  displayName: string;
  username: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character: string): string => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character] ?? character;
  });
}

export function renderDashboard(user: DashboardUser): string {
  const displayName: string = escapeHtml(user.displayName);
  const username: string = escapeHtml(user.username);
  const initial: string = escapeHtml(user.displayName.charAt(0).toUpperCase() || "U");
  const currentDate: string = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date());

  return `
  <div class="app-shell">
    <aside class="sidebar" aria-label="Main navigation">
      <a class="brand" href="/dashboard" aria-label="Finance home">
        <span class="brand-mark" aria-hidden="true">F</span>
        <span>Finance</span>
      </a>
      <button class="mobile-menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="main-navigation"><span aria-hidden="true">☰</span></button>
      <div class="mobile-menu-panel">
      <div class="workspace-label">WORKSPACE</div>
      ${renderMainNavigation("overview")}
      <div class="sidebar-bottom">
        <div class="profile-avatar" aria-hidden="true">${initial}</div>
        <div class="profile-copy">
          <strong>${displayName}</strong>
          <span>@${username}</span>
          <span class="app-version">Version ${escapeHtml(appVersion)}</span>

        </div>
      </div>
      </div>
    </aside>

    <main class="main-content" id="overview">

      <p id="settings-message" class="auth-message" role="status" hidden></p>

      <section class="page-heading">
        <div>
          <p class="eyebrow">${currentDate.toUpperCase()}</p>
          <h1>Welcome, ${displayName} <span aria-hidden="true">✳</span></h1>
          <p class="subheading">Here’s what’s happening with your money.</p>
        </div>

      </section>

      <p class="bank-data-notice">Add accounts manually and import CSV, OFX, or QFX transactions. Automatic bank syncing is unavailable; previously saved data remains available.</p>

      <section class="summary-grid" aria-label="Financial summary">
        <article class="summary-card balance-card">
          <div class="card-label">Total balance</div>
          <div class="card-value" id="overview-total-balance">Loading…</div>
          <div class="card-foot"><span>Across saved accounts</span></div>
          <div class="balance-decoration" aria-hidden="true"></div>
        </article>
      </section>

      <section class="content-grid">
        <article class="panel transactions-panel" id="transactions">
          <div class="panel-heading">
            <div><h2>Recent transactions</h2><p>Your latest activity at a glance</p></div>
            <a class="text-button" href="/transactions">See all</a>
          </div>
          <div id="transaction-list" class="transaction-empty" aria-live="polite">Loading transactions…</div>
        </article>

        <article class="panel accounts-panel" id="accounts">
          <div class="panel-heading">
            <div><h2>Bank accounts</h2><p>Manual accounts and saved balances</p></div>
            <a class="text-button" href="/accounts">See all</a>
          </div>
          <div id="overview-bank-accounts" aria-live="polite">
            <div class="account-empty">Loading your bank accounts…</div>
          </div>

        </article>
      </section>

      <footer class="page-footer">Your finances, in focus. <span>Finance · Personal finance</span></footer>
    </main>
  </div>
  `;
}
