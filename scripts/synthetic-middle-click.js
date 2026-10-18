// Chrome DevTools MCP evaluate_script: format="function", args=[latest snapshot UID].
// This exercises the extension's DOM event path; it is not trusted mouse input.
async function syntheticMiddleClick(element) {
  if (!/^(www\.)?chatgpt\.com$/.test(location.hostname)) {
    throw new Error('Run this test on ChatGPT in the dedicated Chrome.');
  }
  if (!element?.isConnected || !element.closest('nav')) {
    throw new Error('Select a sidebar navigation target from a fresh snapshot.');
  }
  let targetKind;
  let expectedPath;
  const href = element.matches('a[href]') ? new URL(element.getAttribute('href'), location.href) : null;
  const projectId = element.getAttribute('data-app-action-sidebar-project-id');
  if (element.matches('button') && element.textContent.trim() === '新しいチャット') {
    targetKind = 'new-chat';
    expectedPath = '/';
  } else if (href?.origin === location.origin && /^(?:\/g\/g-p-[a-z0-9-]+)?\/c\/[a-z0-9-]+\/?$/i.test(href.pathname)) {
    targetKind = 'conversation';
    expectedPath = href.pathname;
  } else if (element.matches('[role="button"][data-app-action-sidebar-project-row]') && /^g-p-[a-z0-9-]+$/i.test(projectId || '')) {
    targetKind = 'project';
    expectedPath = `/g/${projectId}/project`;
  } else {
    throw new Error('Only New chat, conversation links, and project navigation rows are supported.');
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Target is not visible.');
  const base = {
    bubbles: true, cancelable: true, composed: true, button: 1,
    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
  };
  const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const events = [
    new PointerEvent('pointerdown', { ...base, ...pointer, buttons: 4 }),
    new MouseEvent('mousedown', { ...base, buttons: 4 }),
    new PointerEvent('pointerup', { ...base, ...pointer, buttons: 0 }),
    new MouseEvent('mouseup', { ...base, buttons: 0 }),
    new MouseEvent('auxclick', { ...base, buttons: 0 })
  ].map(event => {
    element.dispatchEvent(event);
    return { type: event.type, isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented };
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  return { mode: 'synthetic-middle-button', targetKind, expectedPath, events };
}
