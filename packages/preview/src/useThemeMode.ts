/**
 * useThemeMode — the resolved light/dark theme currently stamped on <html data-theme>.
 *
 * index.html resolves "system" to a concrete value before first paint and ThemeToggle re-stamps it
 * on change, so the attribute is the single source of truth. Observing it keeps consumers correct
 * for both paths without duplicating the preference logic.
 */

import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

function readThemeMode(): ThemeMode {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode);

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(readThemeMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    // The attribute can change between first render and this effect running.
    setMode(readThemeMode());
    return () => observer.disconnect();
  }, []);

  return mode;
}
