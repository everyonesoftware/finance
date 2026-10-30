import { appVersion } from "./app-version.ts";

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
      <div class="workspace-label">WORKSPACE</div>
      <nav class="navigation">
        <a class="nav-link active" href="#overview" aria-current="page">
          <span class="nav-icon" aria-hidden="true">◫</span> Overview
        </a>
        <a class="nav-link" href="#transactions">
          <span class="nav-icon" aria-hidden="true">↕</span> Transactions
        </a>
        <a class="nav-link" href="#budgets">
          <span class="nav-icon" aria-hidden="true">▤</span> Budgets
        </a>
        <a class="nav-link" href="/accounts">
          <span class="nav-icon" aria-hidden="true">▣</span> Accounts
        </a>
        <a class="nav-link" href="/settings">
          <span class="nav-icon" aria-hidden="true">⚙</span> Settings
        </a>
      </nav>
      <div class="sidebar-bottom">
        <div class="profile-avatar" aria-hidden="true">${initial}</div>
        <div class="profile-copy">
          <strong>${displayName}</strong>
          <span>@${username}</span>
          <span class="app-version">Version ${escapeHtml(appVersion)}</span>
        </div>
      </div>
    </aside>

    <main class="main-content" id="overview">
      <header class="topbar">
        <div class="breadcrumb">Workspace <span>/</span> Overview</div>
        <div class="header-actions">
          <a class="settings-shortcut" href="/accounts">Accounts</a>
          <a class="settings-shortcut" href="/settings">Settings</a>
          <button class="text-button logout-button" type="button">Log out</button>
        </div>
      </header>
      <p id="settings-message" class="auth-message" role="status" hidden></p>

      <section class="page-heading">
        <div>
          <p class="eyebrow">${currentDate.toUpperCase()}</p>
          <h1>Welcome, ${displayName} <span aria-hidden="true">✳</span></h1>
          <p class="subheading">Here’s what’s happening with your money.</p>
        </div>
        <button class="primary-button" type="button" id="sync-transactions">Sync transactions</button>
      </section>

      <section class="summary-grid" aria-label="Financial summary">
        <article class="summary-card balance-card">
          <div class="card-label">Total balance <span aria-hidden="true">↗</span></div>
          <div class="card-value" id="overview-total-balance">Loading…</div>
          <div class="card-foot"><span>Across connected accounts</span></div>
          <div class="balance-decoration" aria-hidden="true"></div>
        </article>
        <article class="summary-card">
          <div class="card-label">Income <span class="metric-icon income-icon" aria-hidden="true">↙</span></div>
          <div class="card-value">—</div>
          <div class="card-foot"><span>Not available yet</span></div>
        </article>
        <article class="summary-card">
          <div class="card-label">Expenses <span class="metric-icon expense-icon" aria-hidden="true">↗</span></div>
          <div class="card-value">—</div>
          <div class="card-foot"><span>Not available yet</span></div>
        </article>
      </section>

      <section class="content-grid">
        <article class="panel spending-panel" id="budgets">
          <div class="panel-heading">
            <div><h2>Spending overview</h2><p>Trends from synced transactions</p></div>
          </div>
          <div class="chart" role="status">
            <div class="chart-placeholder">Sync transactions to see income and spending trends</div>
          </div>
        </article>

        <article class="panel accounts-panel" id="accounts">
          <div class="panel-heading">
            <div><h2>Bank accounts</h2><p>Accounts connected to your profile</p></div>
            <a class="text-button" href="/accounts">See all</a>
          </div>
          <div id="overview-bank-accounts" aria-live="polite">
            <div class="account-empty">Loading your bank accounts…</div>
          </div>
          <a class="connect-button" href="/accounts"><span aria-hidden="true">＋</span> Connect an account</a>
        </article>
      </section>

      <section class="panel transactions-panel" id="transactions">
        <div class="panel-heading">
          <div><h2>Recent transactions</h2><p>Your latest activity at a glance</p></div>
          <button class="text-button" type="button">View all transactions <span aria-hidden="true">→</span></button>
        </div>
        <div id="transaction-list" class="transaction-empty" aria-live="polite">Loading transactions…</div>
        <p id="transaction-status" role="status"></p>
      </section>

      <footer class="page-footer">Your finances, in focus. <span>Finance · Personal finance</span></footer>
    </main>
  </div>
  `;
}
