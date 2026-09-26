import { useEffect, useState } from "react";

const STORAGE_KEY = "qcdao-theme";

function storedTheme() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function initialTheme() {
  if (typeof window === "undefined") return "light";
  return storedTheme() ?? systemTheme();
}

export function applyTheme(theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

// Light/dark preference. An explicit choice is remembered per browser; until
// then the page follows the operating system, including when it changes live.
export function useTheme() {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;
    const follow = (event) => {
      if (!storedTheme()) setTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener?.("change", follow);
    return () => media.removeEventListener?.("change", follow);
  }, []);

  const toggleTheme = () => setTheme((current) => {
    const next = current === "dark" ? "light" : "dark";
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
    return next;
  });

  return { theme, toggleTheme };
}
