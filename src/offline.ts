export const registerOfflineWorker = async () => {
  if (!('serviceWorker' in navigator)) return;
  let controlled = navigator.serviceWorker.controller !== null;
  const registration = await navigator.serviceWorker.register(new URL('service-worker.js', document.baseURI));
  const announceWaiting = () => {
    if (registration.waiting) window.dispatchEvent(new CustomEvent('spc-update-available'));
  };
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'offline-ready') {
      window.dispatchEvent(new CustomEvent('spc-offline-ready', { detail: event.data.revision }));
    }
  });
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', announceWaiting);
  });
  window.addEventListener('spc-activate-update', () => registration.waiting?.postMessage({ type: 'activate-update' }));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Initial clients.claim() needs no reload and must preserve selected music.
    if (controlled) window.location.reload();
    controlled = true;
  });
  announceWaiting();
  const ready = await navigator.serviceWorker.ready;
  ready.active?.postMessage({ type: 'offline-status' });
};
