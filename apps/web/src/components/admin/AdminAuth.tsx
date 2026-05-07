import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { getToken, setToken, clearToken, api } from '@/lib/api';

interface AuthCtx {
  isAuthed: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
}

const AdminAuthContext = createContext<AuthCtx | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [isAuthed, setIsAuthed] = useState(false);

  useEffect(() => {
    if (getToken()) {
      // Verify stored token is still valid
      api.metrics()
        .then(() => setIsAuthed(true))
        .catch(() => { clearToken(); setIsAuthed(false); });
    }
  }, []);

  const login = async (token: string) => {
    setToken(token);
    try {
      await api.metrics();
      setIsAuthed(true);
    } catch {
      clearToken();
      throw new Error('Invalid token');
    }
  };

  const logout = () => {
    clearToken();
    setIsAuthed(false);
  };

  return (
    <AdminAuthContext.Provider value={{ isAuthed, login, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth(): AuthCtx {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be inside AdminAuthProvider');
  return ctx;
}
