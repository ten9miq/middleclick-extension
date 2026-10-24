// Chrome DevTools MCP evaluate_script: format="function", args=[fresh snapshot UID].
// Select a safe navigation control. This sends synthetic events, not physical input.
async function syntheticMiddleClick(element) {
  if (!/^https?:$/.test(location.protocol)) throw new Error('Use an HTTP(S) test page.');
  if (!element?.isConnected || !element.matches('a, area, button, [role="link"], [role="button"]')) {
    throw new Error('Select a visible navigation control from a fresh snapshot.');
  }
  if (element.closest('form') || element.form || element.hasAttribute('aria-haspopup')) {
    throw new Error('Do not select forms or action menus.');
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Target is not visible.');
  const target = element.querySelector('use') || element.querySelector('svg') || element.querySelector('img') || element;
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
    target.dispatchEvent(event);
    return { type: event.type, isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented };
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  return { mode: 'synthetic-middle-button', targetTag: target.tagName,
    href: element.getAttribute('href'), events };
}
