/** VITE_ values are public: reject private wallet settings before bundling. */
export function assertPublicPrivyEnvironment(environment) {
  const privateNames = Object.keys(environment).filter(name =>
    /^VITE_PRIVY_/i.test(name) && /SECRET|PRIVATE_KEY|AUTHORIZATION_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN/i.test(name));
  if (privateNames.length) {
    throw new Error(`Privy server credentials cannot use the public VITE_ prefix: ${privateNames.sort().join(", ")}. Keep them in the functions environment or Secret Manager.`);
  }
}

export function publicPrivyEnvironment() {
  return {
    name: "qcdao-public-privy-environment",
    configResolved(config) {
      assertPublicPrivyEnvironment(config.env);
    },
  };
}
