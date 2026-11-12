import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../src/App';

vi.mock('../src/aram/AramPanel', () => ({ AramPanel: () => createElement('section', { 'data-panel': 'aram' }) }));
vi.mock('../src/library/storage', () => ({ loadSavedLibrary: async () => null }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const mount = async () => { await act(async () => root.render(createElement(App))); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;

test('top-level views follow the native order and transport begins with labeled symbols', async () => {
  await mount();
  expect([...container.querySelectorAll('.view-tabs button')].map(node => node.textContent)).toEqual(['ARAM', 'Voices', 'DSP', 'Spectrogram', 'Track', 'Settings', 'About']);
  expect(container.querySelector('.topbar')?.textContent).not.toContain('Visual SPC Player');
  expect(container.querySelector('.transport > button')?.getAttribute('aria-label')).toBe('Play');
  expect(container.querySelector('.transport > button svg')).not.toBeNull();
  expect(container.querySelector('.app-footer')).not.toBeNull();
});

test('library border tab collapses, reopens and remembers pinned layout independently', async () => {
  await mount();
  const toggle = () => container.querySelector<HTMLButtonElement>('.library-toggle')!;
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  act(() => container.querySelector<HTMLButtonElement>('.library-pin')!.click());
  expect(container.querySelector('.workspace')?.classList.contains('library-pinned')).toBe(true);
  act(() => toggle().click());
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector<HTMLElement>('.library-panel')?.hidden).toBe(true);
  act(() => toggle().click());
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  act(() => root.unmount()); root = createRoot(container);
  await mount();
  expect(container.querySelector('.workspace')?.classList.contains('library-pinned')).toBe(true);
});

test('About embeds usage, attribution and license text and offers the complete source archive', async () => {
  await mount(); act(() => button('About').click());
  expect(container.querySelector('.about-panel')?.textContent).toContain('Shay Green');
  const summaries = [...container.querySelectorAll('.about-panel details > summary')].map(node => node.textContent);
  expect(summaries).toContain('Usage');
  expect(summaries).toContain('Application license (MIT)');
  expect(summaries).toContain('Source and rebuilding');
  expect(container.querySelector<HTMLAnchorElement>('.about-panel a[download="Visual-SPC-Player-source.zip"]')?.getAttribute('href')).toBe('./Visual-SPC-Player-source.zip');
  expect(container.querySelector('.about-panel')?.textContent).toContain('Permission is hereby granted');
});
