import type { SiteAccessState } from "../shared/types";

type SiteAccessPolicyInput = Pick<SiteAccessState, "originPattern" | "allSitesGranted" | "isFile">
  & { filePermission: boolean; blockedOrigins: readonly string[] };

export function isSiteEnabledByPolicy(input: SiteAccessPolicyInput): boolean {
  if (input.isFile) {
    return input.filePermission;
  }
  return input.allSitesGranted && !input.blockedOrigins.includes(input.originPattern);
}
