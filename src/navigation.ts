export type MainNavigationPage = "overview" | "transactions" | "real-estate" | "accounts" | "settings";

const navigationItems: Array<{ page: MainNavigationPage; href: string; icon: string; label: string }> = [
  { page: "overview", href: "/dashboard", icon: "◫", label: "Overview" },
  { page: "transactions", href: "/transactions", icon: "↕", label: "Transactions" },

  { page: "real-estate", href: "/real-estate", icon: "⌂", label: "Real Estate" },
  { page: "accounts", href: "/accounts", icon: "▣", label: "Accounts" },
  { page: "settings", href: "/settings", icon: "⚙", label: "Settings" },
];

export function renderMainNavigation(activePage: MainNavigationPage): string {
  const links = navigationItems.map(({ page, href, icon, label }) => {
    const active = page === activePage;
    return `<a class="nav-link${active ? " active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">${icon}</span> ${label}</a>`;
  }).join("");
  return `<nav class="navigation" id="main-navigation">${links}</nav>`;
}
