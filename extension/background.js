chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("options.html");

  // Se já existir, foca na aba ao invés de abrir uma nova.
  const existing = await chrome.tabs.query({ url });
  if (existing?.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }

  // Caso contrário, abre uma única janela (popup) com dimensões padrão.
  await chrome.windows.create({
    url,
    type: "popup",
    width: 420,
    height: 700
  });
});
