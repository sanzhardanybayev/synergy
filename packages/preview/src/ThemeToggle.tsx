/**
 * ThemeToggle — three-state (system / light / dark) segmented control.
 *
 * The stored preference lives in localStorage under "synergy-theme"
 * ("light" | "dark"; absent = follow system). index.html stamps the resolved
 * theme on <html data-theme> before first paint; this control updates the
 * stored preference and re-stamps immediately.
 */

import { useCallback, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from './icons.js';

const KEY = 'synergy-theme';

type ThemePref = 'system' | 'light' | 'dark';

function readPref(): ThemePref {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable — fall through to system.
  }
  return 'system';
}

function applyPref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Preference just won't persist across reloads.
  }
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
}

const OPTIONS: { value: ThemePref; label: string; Icon: typeof SunIcon }[] = [
  { value: 'system', label: 'System theme', Icon: MonitorIcon },
  { value: 'light', label: 'Light theme', Icon: SunIcon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon },
];

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(readPref);

  const select = useCallback((next: ThemePref) => {
    setPref(next);
    applyPref(next);
  }, []);

  return (
    <div className="theme-toggle">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={pref === value}
          aria-label={label}
          title={label}
          className={`theme-toggle__option${pref === value ? ' theme-toggle__option--active' : ''}`}
          onClick={() => select(value)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
