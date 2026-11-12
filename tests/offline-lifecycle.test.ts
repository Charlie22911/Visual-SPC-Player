// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { registerOfflineWorker } from '../src/offline';

afterEach(() => vi.unstubAllGlobals());

function environment(controlled: boolean) {
  const reload = vi.fn(), postMessage = vi.fn();
  const registration = Object.assign(new EventTarget(), {
    active: { postMessage }, waiting: { postMessage }, installing: null,
  });
  const worker = Object.assign(new EventTarget(), {
    controller: controlled ? {} : null,
    register: vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
  });
  const page = Object.assign(new EventTarget(), { location: { reload } });
  vi.stubGlobal('navigator', { serviceWorker: worker });
  vi.stubGlobal('window', page);
  vi.stubGlobal('document', { baseURI: 'https://example.test/player/' });
  return { worker, page, reload, postMessage };
}

test('first offline activation preserves playback, and a later update reloads', async () => {
  const { worker, reload } = environment(false);
  await registerOfflineWorker();
  worker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
  worker.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledOnce();
});

test('replacing an existing offline controller reloads after update activation', async () => {
  const { worker, page, reload, postMessage } = environment(true);
  await registerOfflineWorker();
  page.dispatchEvent(new Event('spc-activate-update'));
  expect(postMessage).toHaveBeenCalledWith({ type: 'activate-update' });
  expect(reload).not.toHaveBeenCalled();
  worker.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledOnce();
});
