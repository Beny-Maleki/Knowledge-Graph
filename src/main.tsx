import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initPersistence } from './store/persist';
import { bootCloud, primeFromCache } from './lib/cloud';
import './styles.css';

// Show the last opened graph immediately (signed-in cloud copy or guest copy),
// then connect to the cloud in the background.
initPersistence(primeFromCache() ?? { kind: 'guest' }).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void bootCloud();
});
