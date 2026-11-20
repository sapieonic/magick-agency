import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initAnalytics } from './analytics/posthog';
import { applyBrandColors, applyBrandLayout } from './brand';
import { applyTheme, initialTheme } from './contexts/ThemeContext';
import '@magick-agency/web-ui/global.css';

// Apply the active whitelabel brand's accent colors + layout before first paint.
applyBrandColors();
applyBrandLayout();
// AS14: light unless the user chose dark, on the document before the first paint (web-ui's `:root`
// is the dark theme, so waiting for the provider would flash dark on every load).
applyTheme(initialTheme());

// Initialize product analytics once at bootstrap. No-op when no key is set.
initAnalytics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
