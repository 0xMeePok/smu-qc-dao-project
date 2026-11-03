# Due sandbox on/off-ramp

**Add funds** on the account menu and on the escrow panel keeps the Due sandbox screens. No Due account is created and no request is sent to Due. A platform key is not available, so the quote, bank details, funding reference, and pay-in result are simulated. The dialog is labelled **Testnet simulation**. Nothing is charged and no token moves.

The page does not read `DUE_API_KEY`. A signed-in member can finish both a buy and a sale without a Due account. The simulated account id is `acct_mock_` plus part of the wallet address. **Simulate sandbox pay-in** only changes the simulated status to `payment_processed`. The sale shows `mock-funding-tf_1`, which is not a wallet address.

`dueSandbox` returns the same simulation for a deployed callable and does not call `api.sandbox.due.network`. Replace `handleDueSandbox` in `firebase/functions/dueSandboxFunctions.js` and `runDueRampMock` in `frontend/src/lib/dueRampMock.js` when a sandbox platform key exists.

## What to click

1. Sign in and open **Add funds** from the account menu, or from an escrow panel.
2. Leave **Buy USDC** and USD. Enter `100`. Choose **Review quote**, **Continue to confirmation**, and **Create sandbox transfer**.
3. The bank is "QC DAO testnet bank" and the account number is all zeroes. Choose **Simulate sandbox pay-in**. The status becomes `payment_processed`. The wallet balance does not change.
4. Open **Add funds** again. Choose **Sell USDC**, enter `100`, and create the transfer. The funding reference starts with `mock-funding-`. There is no **Send** button. **Check status** leaves it at `awaiting_funds`.
