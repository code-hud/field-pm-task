import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);
const STORAGE_KEY = 'fpd.theme';

/**
 * Three states: 'system' follows the OS, 'light'/'dark' stamp data-theme on <html>.
 * The stamp has to win over prefers-color-scheme in both directions — see tokens.css.
 */
export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(() => localStorage.getItem(STORAGE_KEY) ?? 'system');

  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') {
      root.removeAttribute('data-theme');
      localStorage.removeItem(STORAGE_KEY);
    } else {
      root.setAttribute('data-theme', preference);
      localStorage.setItem(STORAGE_KEY, preference);
    }
  }, [preference]);

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event) => setSystemDark(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  const toggle = useCallback(() => setPreference(resolved === 'dark' ? 'light' : 'dark'), [resolved]);

  const value = useMemo(() => ({ preference, resolved, toggle, setPreference }), [preference, resolved, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
