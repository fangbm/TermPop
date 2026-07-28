export const EDGE_ADDONS_URL =
  "https://microsoftedge.microsoft.com/addons/detail/termpop/blphbffphknkkblackimhnjbckegnchn";
export const GITHUB_RELEASES_URL = "https://github.com/fangbm/TermPop/releases/latest";

export type DownloadTarget = {
  kind: "edge" | "github";
  url: string;
};

export function isMicrosoftEdge(userAgent: string): boolean {
  return /\bEdg(?:A|iOS)?\//i.test(userAgent);
}

export function getDownloadTarget(userAgent: string): DownloadTarget {
  return isMicrosoftEdge(userAgent)
    ? { kind: "edge", url: EDGE_ADDONS_URL }
    : { kind: "github", url: GITHUB_RELEASES_URL };
}
