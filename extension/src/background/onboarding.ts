import { termpopWebsiteUrl } from "../shared/website";

export function setupOnboarding(): void {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") {
      return;
    }

    void chrome.tabs.create({
      url: termpopWebsiteUrl("/guide", "install"),
      active: true
    });
  });
}
