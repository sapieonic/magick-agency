import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initAnalytics } from './analytics/posthog';
import { applyBrandColors, applyBrandLayout } from './brand';
import './global.css';

// Apply the active whitelabel brand's accent colors + layout before first paint.
applyBrandColors();
applyBrandLayout();

// Initialize product analytics once at bootstrap. No-op when no key is set.
initAnalytics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
