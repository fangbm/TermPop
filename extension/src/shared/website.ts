export const TERMPOP_SITE_URL = "https://termpop-site.pages.dev";

export function termpopWebsiteUrl(path: "/guide" | "/docs", source?: string): string {
  const url = new URL(path, TERMPOP_SITE_URL);
  if (source) {
    url.searchParams.set("source", source);
  }
  return url.toString();
}
