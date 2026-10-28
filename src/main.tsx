import React from 'react';
import ReactDOM from 'react-dom/client';
import { CloudGate } from './components/CloudGate';
import './style.css';
import './compact.css';
import './homepage.css';
import './v11.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CloudGate />
  </React.StrictMode>,
);
