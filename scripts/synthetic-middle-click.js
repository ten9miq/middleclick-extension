// Chrome DevTools MCP evaluate_script: format="function", args=[fresh snapshot UID].
// Select a safe navigation control. This sends synthetic events, not physical input.
async function syntheticMiddleClick(element) {
  if (!/^https?:$/.test(location.protocol)) throw new Error('Use an HTTP(S) test page.');
  const driveItem = location.origin === 'https://drive.google.com' &&
    element?.matches('[role="row"], [role="gridcell"]') &&
    element.getAttribute('data-target') === 'doc' && element.hasAttribute('data-selectable');
  const driveCurrentFolder = location.origin === 'https://drive.google.com' &&
    element?.getAttribute('role') === 'button' &&
    element.getAttribute('data-target') !== 'collapsedFolderButton' &&
    element.parentElement?.getAttribute('guidedhelpid') === 'folder_path_button' &&
    element.closest('nav[guidedhelpid="folder_path"]');
  const driveBreadcrumbMenuItem = location.origin === 'https://drive.google.com' &&
    element?.getAttribute('role') === 'menuitem' && element.getAttribute('data-target') === 'folder' &&
    element.closest('[data-target="collapsedFolderDropdown"]')?.getAttribute('role') === 'menu';
  if (!element?.isConnected || (!driveItem && !driveBreadcrumbMenuItem && !element.matches('a, area, button, [role="link"], [role="button"]'))) {
    throw new Error('Select a visible navigation control from a fresh snapshot.');
  }
  if (element.closest('form') || element.form || (element.hasAttribute('aria-haspopup') && !driveCurrentFolder)) {
    throw new Error('Do not select forms or action menus.');
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Target is not visible.');
  const itemLabel = driveItem ? [...element.querySelectorAll('[data-id][data-tooltip]')].find(node =>
    node.getAttribute('data-id') === element.getAttribute('data-id')) : null;
  const content = itemLabel || element;
  const target = content.querySelector('use') || content.querySelector('svg') || content.querySelector('img') || content;
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
