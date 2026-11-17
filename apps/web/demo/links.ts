// The reader pages link with root paths ("/archive"); on GitHub Pages the site lives under a base path
// ("/topka/"). This keeps every such href pointing inside the base (so a new tab works too) and turns a
// plain click into an in-app navigation.
export function withBase(href: string, base: string): string {
  if (!href.startsWith("/") || href.startsWith("//") || base === "/" || href === base.replace(/\/$/, "") || href.startsWith(base)) return href;
  return `${base.replace(/\/$/, "")}${href}`;
}

/** The in-app path ("/archive?x") of a same-site href under `base`, or null for anything else. */
export function appPath(href: string, base: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const root = base.replace(/\/$/, "");
  if (root && href !== root && !href.startsWith(`${root}/`)) return null;
  return href.slice(root.length) || "/";
}

export function rebaseLinks(root: HTMLElement, base: string, navigate: (to: string) => void): () => void {
  const fix = (el: Element) => {
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute("href");
      if (href) {
        const next = withBase(href, base);
        if (next !== href) el.setAttribute("href", next);
      }
    }
  };
  const scan = (node: Node) => {
    if (node instanceof Element) {
      fix(node);
      node.querySelectorAll("a[href]").forEach(fix);
    }
  };
  scan(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") fix(r.target as Element);
      r.addedNodes.forEach(scan);
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const path = appPath(a.getAttribute("href") ?? "", base);
    if (path === null) return;
    e.preventDefault();
    navigate(path);
  };
  document.addEventListener("click", onClick);
  return () => {
    observer.disconnect();
    document.removeEventListener("click", onClick);
  };
}
