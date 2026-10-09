import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { superAdminLogin, getSuperAdminMe, setToken, clearToken, hasToken } from '../api/super-admin';
import type { SuperAdmin, SuperAdminLoginResponse } from '@magick-agency/contracts/api/platform/super-admin';

interface SuperAdminState {
  admin: SuperAdmin | null;
  loading: boolean;
  error: string | null;
}

interface SuperAdminContextValue extends SuperAdminState {
  login: (email: string, password: string) => Promise<SuperAdminLoginResponse>;
  logout: () => void;
  isAuthenticated: boolean;
}

const SuperAdminContext = createContext<SuperAdminContextValue | null>(null);

export function SuperAdminProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SuperAdminState>({
    admin: null,
    loading: true,
    error: null,
  });

  // Validate token on mount
  useEffect(() => {
    if (!hasToken()) {
      setState({ admin: null, loading: false, error: null });
      return;
    }

    getSuperAdminMe()
      .then(res => {
        setState({ admin: res.admin, loading: false, error: null });
      })
      .catch(() => {
        clearToken();
        setState({ admin: null, loading: false, error: null });
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await superAdminLogin(email, password);
      setToken(res.token);
      // Fetch full admin profile
      const me = await getSuperAdminMe();
      setState({ admin: me.admin, loading: false, error: null });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setState(prev => ({ ...prev, loading: false, error: msg }));
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setState({ admin: null, loading: false, error: null });
  }, []);

  return (
    <SuperAdminContext.Provider value={{ ...state, login, logout, isAuthenticated: !!state.admin }}>
      {children}
    </SuperAdminContext.Provider>
  );
}

export function useSuperAdmin(): SuperAdminContextValue {
  const ctx = useContext(SuperAdminContext);
  if (!ctx) throw new Error('useSuperAdmin must be used within SuperAdminProvider');
  return ctx;
}
