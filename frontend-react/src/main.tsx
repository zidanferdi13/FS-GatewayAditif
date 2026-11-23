import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { loadThresholds } from './utils/scaleUtils';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// Thresholds must be in place before any component reads them (falls back to defaults after 2 s)
loadThresholds().finally(() =>
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
