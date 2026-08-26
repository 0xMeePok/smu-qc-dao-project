export function parseRoute() {
  return window.location.hash.replace(/^#\/?/, "") || "home";
}

export function go(route) {
  window.location.hash = `/${route}`;
}
