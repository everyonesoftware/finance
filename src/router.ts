export function isAppPath(path: string): boolean {
  return ["/", "/dashboard", "/transactions", "/real-estate", "/accounts", "/settings"].includes(path)
    || /^\/accounts\/[^/]+$/.test(path);
}

/** Keep real URLs and ordinary link behavior while replacing in-app document loads. */
export function createClientRouter(
  render: () => void,
  browser: Window = window,
  documentRoot: Document = document,
): { navigate: (href: string, options?: { replace?: boolean }) => void; dispose: () => void } {
  const navigate = (href: string, options: { replace?: boolean } = {}): void => {
    const url = new URL(href, browser.location.href);
    if (url.origin !== browser.location.origin || !isAppPath(url.pathname)) return;
    const destination = url.pathname + url.search + url.hash;
    if (destination === browser.location.pathname + browser.location.search + browser.location.hash) return;
    browser.history[options.replace ? "replaceState" : "pushState"](null, "", destination);
    render();
    browser.scrollTo(0, 0);
  };
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const url = new URL(anchor.href, browser.location.href);
    if (url.origin !== browser.location.origin || !isAppPath(url.pathname)) return;
    if (url.hash && url.pathname === browser.location.pathname && url.search === browser.location.search) return;
    event.preventDefault();
    navigate(url.href);
  };
  documentRoot.addEventListener("click", onClick);
  browser.addEventListener("popstate", render);
  return {
    navigate,
    dispose: () => {
      documentRoot.removeEventListener("click", onClick);
      browser.removeEventListener("popstate", render);
    },
  };
}

/** Programmatic page actions use the same delegated routing path as ordinary links. */
export function navigateTo(href: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
