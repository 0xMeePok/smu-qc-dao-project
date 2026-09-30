const empty = { address: null, chainId: undefined, getProvider: null };
let active = empty;

/** The Privy wallet currently shown in the app. Contract writes read this at call time. */
export function registerActiveWallet(wallet) {
  active = wallet ?? empty;
}

export function getActiveWallet() {
  return active;
}
