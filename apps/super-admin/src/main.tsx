import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, initialTheme } from './theme';
import '@magick-agency/web-ui/global.css';

// AS14: light unless the operator chose dark; set before the first paint, the login page included.
applyTheme(initialTheme());

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
