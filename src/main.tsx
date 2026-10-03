import { createRoot } from 'react-dom/client';
import App from './App';
import { registerOfflineWorker } from './offline';
import { getStandaloneAssets } from './standalone';

createRoot(document.getElementById('root')!).render(<App />);

if (!getStandaloneAssets() && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void registerOfflineWorker();
  });
}
