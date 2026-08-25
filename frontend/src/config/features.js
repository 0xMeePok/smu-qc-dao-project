/**
 * Feature Flags Configuration
 *
 * Controls conditional exposure of demo and experimental capabilities.
 * Demo features are disabled by default for production safety and can be
 * toggled via environment variables (VITE_ENABLE_DEMO_MODE=true) or the URL parameter (?demo=true).
 */
function checkDemoFlag() {
  if (typeof window === "undefined") return false;
  try {
    const isEnvEnabled = import.meta.env?.VITE_ENABLE_DEMO_MODE === "true";
    const isUrlEnabled =
      window.location.search.includes("demo=true") ||
      window.location.hash.includes("demo=true");
    return isEnvEnabled || isUrlEnabled;
  } catch {
    return false;
  }
}

export const FEATURES = {
  DEMO_ROLE_SWITCHER: checkDemoFlag(),
};
