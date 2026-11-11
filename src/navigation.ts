import { appVersion } from "./app-version.ts";
import { escapeHtml } from "./html-utils.ts";

export type MainNavigationPage = "overview" | "transactions" | "real-estate" | "accounts" | "settings";

export function renderAppNavigation(user: { displayName: string; username: string }, activePage: MainNavigationPage): string {
  const displayName = escapeHtml(user.displayName);
  const username = escapeHtml(user.username);
  const initial = escapeHtml(user.displayName.charAt(0).toUpperCase() || "U");
  return `
    <aside class="sidebar" aria-label="Main navigation">
      <a class="brand" href="/dashboard" aria-label="Finance home"><span class="brand-mark" aria-hidden="true">F</span><span>Finance</span></a>
      <div class="workspace-label">WORKSPACE</div>
      ${renderMainNavigation(activePage)}
      <div class="sidebar-bottom">
        <div class="profile-avatar" aria-hidden="true">${initial}</div>
        <div class="profile-copy"><strong>${displayName}</strong><span>@${username}</span><span class="app-version">Version ${escapeHtml(appVersion)}</span></div>
      </div>
    </aside>
    ${renderMobileNavigation(activePage)}
  `;
}

const navigationItems: Array<{ page: MainNavigationPage; href: string; icon: string; label: string }> = [
  { page: "overview", href: "/dashboard", icon: "◫", label: "Overview" },
  { page: "transactions", href: "/transactions", icon: "↕", label: "Transactions" },

  { page: "real-estate", href: "/real-estate", icon: "⌂", label: "Real Estate" },
  { page: "accounts", href: "/accounts", icon: "▣", label: "Accounts" },
  { page: "settings", href: "/settings", icon: "⚙", label: "Settings" },
];

const mobileNavigationIcons: Record<MainNavigationPage, string> = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  transactions: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
  "real-estate": '<path d="m3 10 9-7 9 7v11H3Z M9 21v-8h6v8"/>',
  accounts: '<path d="m3 8 9-5 9 5ZM5 11v6m7-6v6m7-6v6M3 21h18M4 18h16"/>',
  settings: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
};

export function renderMobileNavigation(activePage: MainNavigationPage): string {
  const links = navigationItems.map(({ page, href, label }) => {
    const active = page === activePage;
    return `<a class="mobile-navigation-link${active ? " active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}><span class="mobile-navigation-icon"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${mobileNavigationIcons[page]}</svg></span><span>${label}</span></a>`;
  }).join("");
  return `<nav class="mobile-navigation" aria-label="Mobile navigation">${links}</nav>`;
}

export function renderMainNavigation(activePage: MainNavigationPage): string {
  const links = navigationItems.map(({ page, href, icon, label }) => {
    const active = page === activePage;
    return `<a class="nav-link${active ? " active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">${icon}</span> ${label}</a>`;
  }).join("");
  return `<nav class="navigation" id="main-navigation">${links}</nav>`;
}
