import React from 'react';
import ReactDOM from 'react-dom/client';
import { CloudGate } from './components/CloudGate';
import './style.css';
import './compact.css';
import './homepage.css';
import './v11.css';
import './workbench.css';
import './buttons.css';
import './overview.css';
import './components/photo-editor.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CloudGate />
  </React.StrictMode>,
);

// Register on secure production origins only; API responses are never cached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}
