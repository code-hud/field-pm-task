import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, onSessionExpired, tokenStore } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // 'restoring' until we know whether the stored token is still good.
  const [status, setStatus] = useState(tokenStore.get() ? 'restoring' : 'anonymous');

  useEffect(() => {
    if (status !== 'restoring') return undefined;
    const controller = new AbortController();

    api
      .me(controller.signal)
      .then(({ user: restored }) => {
        setUser(restored);
        setStatus('authenticated');
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        tokenStore.clear();
        setStatus('anonymous');
      });

    return () => controller.abort();
  }, [status]);

  useEffect(
    () =>
      onSessionExpired(() => {
        setUser(null);
        setStatus('anonymous');
      }),
    [],
  );

  const signIn = useCallback(async (username, password) => {
    const { token, user: signedIn } = await api.login(username, password);
    tokenStore.set(token);
    setUser(signedIn);
    setStatus('authenticated');
    return signedIn;
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    tokenStore.clear();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(
    () => ({ user, status, isAuthenticated: status === 'authenticated', signIn, signOut }),
    [user, status, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
