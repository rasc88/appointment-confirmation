import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ApiProvider } from './api/api-context';
import { createMockApi } from './api/mock-api';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ApiProvider api={createMockApi()}>
        <App />
      </ApiProvider>
    </BrowserRouter>
  </StrictMode>,
);
