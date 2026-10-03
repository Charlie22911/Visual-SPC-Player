// Select a renderer variant through the public measurement and representation controls.
export async function selectMemoryView(page, mode) {
  const activity = mode.startsWith('activity');
  const entropy = mode.startsWith('entropy');
  await page.getByLabel('Memory measurement').selectOption(activity ? 'activity' : entropy ? 'entropy' : 'data');
  const group = page.locator(`[aria-label="${activity ? 'Activity' : entropy ? 'Entropy' : 'Data'} representation"]`);
  await group.getByRole('button', { name: mode.endsWith('bits') ? 'Bit' : 'Byte', exact: true }).click();
  if (!activity && !entropy) await page.getByLabel('XOR changes only').setChecked(mode.startsWith('xor'));
}

// Find existing runtime objects by their contracts, without adding a production debug API.
export function memoryRuntime() {
  const element = document.querySelector('.waterfall-plot') ?? document.querySelector('.aram-panel');
  let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
  let stream, history, renderer;
  for (; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
    const value = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : hook.memoizedState;
    if (value?.publish && typeof value.presented === 'number') stream = value;
    if (value?.accept && typeof value.payloadBytes === 'number') history = value;
    if (value?.current?.cache && typeof value.current.currentBand === 'number') renderer = value.current;
  }
  return { stream, history, renderer };
}
