import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '@synergy/spec-kit/styles.css';
import './theme.css';
import './app.css';
import './review/review.css';
import './edit-ui.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ToastProvider } from './ToastProvider.js';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
