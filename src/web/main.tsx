import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, useApp } from './app/store';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

applyTheme(useApp.getState().theme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker only exists in production builds; in development it would
// serve stale modules over Vite's HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell unavailable; the app still works online */
    });
  });
}
