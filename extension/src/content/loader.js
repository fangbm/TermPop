(async () => {
  const source = chrome.runtime.getURL("assets/content.js");
  await import(source);
})();
