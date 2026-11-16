# PGX Gateway Backend (`Pgxgateway`) Instructions

## 1. Arxopay Partner Fee Policy
- **No Client-Direct Setup or Maintenance Fees**: For all sub-merchants under the Arxopay partner umbrella (`resellerId === 'ARXO' || resellerId === 'arxopay' || refId.startsWith('ARXO-')`), clients are never charged setup fees or recurring monthly maintenance fees directly.
- **Wholesale Go-Live Setup Fee ($1,499 via Crypto Only)**:
  - When the Arxopay partner desk requests "Go Live" for an approved sub-merchant, a pop-up modal appears directly to Arxopay.
  - Arxopay pays the wholesale setup fee of **$1,499.00 USD** to PGX Gateway on behalf of the merchant via Crypto only (USDT TRC-20, USDT ERC-20, BTC, USDC).
  - The partner submits the transaction hash (TxID), which is recorded in `merchant.arxopayWholesale.setupFee`.
- **Wholesale Recurring Monthly Maintenance ($499 via Crypto Only)**:
  - From the timestamp a merchant goes live, a 30-day recurring maintenance cycle is initiated (`merchant.arxopayWholesale.monthlyMaintenance.nextDueAt`).
  - When 30 days elapse, an alert appears to Arxopay to pay $499 monthly maintenance to PGX Gateway via Crypto only.
  - Arxopay submits the $499 payment via `POST /api/v1/admin/applications/:id/pay-monthly` with the TxID, resetting the 30-day timer for the next cycle.

## 2. 24-Hour Integration Sandbox Policy
- **Strict Pre-Activation Lock**:
  - If `merchant.accountMode === 'trial'` and `!merchant.trial?.isActive || merchant.trial?.status !== 'active'`, `initiateCheckout` returns `403 TRIAL_NOT_ACTIVATED`.
- **24-Hour Auto-Expiry**:
  - Once turned on by Admin, the trial runs for exactly 24 hours (`merchant.trial.expiresAt`).
  - If `new Date() > new Date(merchant.trial.expiresAt)`, `merchant.trial.status` is set to `expired`, `merchant.trial.isActive` is set to `false`, and `initiateCheckout` returns `403 TRIAL_EXPIRED`.

## 3. Pre-Offer Privacy & Zero Commercial Leaks
- Before an underwriter officially reviews a merchant's business documents and dispatches a customized commercial offer, all fields in `merchant.offer` default to `''` (blank) with `isAvailable: false`.

## 4. Settlement & Rolling Reserve Formula Sync
- `getMerchantTransactions`:
  - Dynamically matures transactions where `settlementEligibleAt <= now` from `on_hold` to `available`.
  - Releases rolling reserves where `rollingReserveReleaseAt <= now` from `locked` to `released`.
  - Computes `onHoldBalance` based on net settlement: `Gross - Processing MDR Fee - Rolling Reserve`.
  - Returns `data`, `metrics`, `payoutHistory`, and `payoutSettings`.

## 5. Daily Deposit Tracking & Admin Disbursement
- `POST /api/v1/admin/merchants/:merchantId/payout` (`markMerchantPayout`):
  - Records the daily disbursement in `merchant.payoutHistory` with `payoutId`, `amount`, `method` ('crypto_usdc' | 'bank_swift'), `destination`, `reference`, `notes`, and `depositedAt`.
  - Deducts the disbursed amount from `merchant.balance.netBalance`.
  - Emits real-time notification to merchant via WebSocket.

## 6. Merchant Payout Settings (USDC & SWIFT)
- `PUT /api/v1/merchants/payout-settings` (`updatePayoutSettings`):
  - Allows merchants to update `payoutSettings.preferredMethod`, `cryptoUsdc` (address, network), and `bankSwift` (beneficiary, bank name, SWIFT/BIC, IBAN, country, routing, address).

## 7. 30-Day Monthly Maintenance Payment with Screenshot
- `POST /api/v1/merchants/monthly-maintenance/pay` (`submitMonthlyMaintenancePayment`):
  - Accepts `txHash`, `currency`, `network`, `notes`, and optional file `req.file` for screenshot.
  - Uploads screenshot to Cloudinary (or base64 fallback) and stores `screenshotUrl` and `screenshotName`.
  - Updates `merchant.arxopayWholesale.monthlyMaintenance` to `pending_verification` and notifies Underwriting.
