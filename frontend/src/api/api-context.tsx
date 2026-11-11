import { createContext, useContext, type ReactNode } from 'react';
import type { ApiService } from './api-service';

const ApiContext = createContext<ApiService | null>(null);

export function ApiProvider({ api, children }: { api: ApiService; children: ReactNode }) {
  return <ApiContext value={api}>{children}</ApiContext>;
}

export function useApi(): ApiService {
  const api = useContext(ApiContext);
  if (!api) {
    throw new Error('useApi must be used inside ApiProvider');
  }
  return api;
}
