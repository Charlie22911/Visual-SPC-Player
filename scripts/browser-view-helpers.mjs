// Select a renderer variant through the public measurement and representation controls.
export async function selectMemoryView(page, mode) {
  const activity = mode.startsWith('activity');
  const entropy = mode.startsWith('entropy');
  await page.getByLabel('Memory measurement').selectOption(activity ? 'activity' : entropy ? 'entropy' : 'data');
  const group = page.locator(`[aria-label="${activity ? 'Activity' : entropy ? 'Entropy' : 'Data'} representation"]`);
  await group.getByRole('button', { name: mode.endsWith('bits') ? 'Bit' : 'Byte', exact: true }).click();
  if (!activity && !entropy) await page.getByLabel('XOR changes only').setChecked(mode.startsWith('xor'));
}

export async function setLibraryOpen(page, open) {
  const toggle = page.locator('.library-toggle');
  if (await toggle.count() && (await toggle.getAttribute('aria-expanded') === 'true') !== open) await toggle.click();
}

// Browser-side pixel sampler. Map inputs are logical memory cells; Waterfall
// inputs are physical output pixels. Read the rendered surface, never CPU data
// or a recreated reference image, for both WebGL and Canvas2D presentations.
export function readMemoryCanvas(canvas, { x, y, width = 1, height = 1, space } = {}) {
  const map = (space ?? (canvas.closest('.map-stage') ? 'map' : 'physical')) === 'map';
  const viewport = map && canvas.style.transform === 'none';
  const scale = Number(canvas.dataset.viewScale), offsetX = Number(canvas.dataset.offsetX), offsetY = Number(canvas.dataset.offsetY);
  const stage = canvas.parentElement;
  const gl = canvas.getContext('webgl2');
  const context = gl ? null : canvas.getContext('2d');
  if (!gl && !context) throw new Error('The memory canvas has no readable rendering context');
  const result = [];
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const px = Math.floor(viewport ? (offsetX + (x + column + .5) * scale) * canvas.width / stage.clientWidth : x + column);
    const py = Math.floor(viewport ? (offsetY + (y + row + .5) * scale) * canvas.height / stage.clientHeight : y + row);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) throw new Error(`Requested memory cell is outside the rendered viewport: ${x + column},${y + row} -> ${px},${py}`);
    if (gl) {
      const pixel = new Uint8Array(4);
      gl.readPixels(px, canvas.height - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL memory pixel read failed');
      result.push(...pixel);
    } else result.push(...context.getImageData(px, py, 1, 1).data);
  }
  return result;
}

export function mapCellPoint(canvas, { x, y }) {
  if (canvas.style.transform === 'none') return { x: Number(canvas.dataset.offsetX) + (x + .5) * Number(canvas.dataset.viewScale), y: Number(canvas.dataset.offsetY) + (y + .5) * Number(canvas.dataset.viewScale) };
  const bounds = canvas.getBoundingClientRect(), stage = canvas.parentElement.getBoundingClientRect();
  return { x: bounds.left - stage.left + (x + .5) * bounds.width / canvas.width, y: bounds.top - stage.top + (y + .5) * bounds.height / canvas.height };
}

export async function installMemoryTools(page) {
  await page.evaluate('window.readMemoryCanvas = ' + readMemoryCanvas.toString());
  await page.evaluate('window.memoryRuntime = ' + memoryRuntime.toString());
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
