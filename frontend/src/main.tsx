import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ApiProvider } from './api/api-context';
import { createHttpApi } from './api/http-api';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ApiProvider api={createHttpApi()}>
        <App />
      </ApiProvider>
    </BrowserRouter>
  </StrictMode>,
);
