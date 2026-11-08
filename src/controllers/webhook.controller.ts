import { Request, Response } from 'express'
import crypto from 'crypto'
import type Stripe from 'stripe'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Merchant } from '../models/Merchant.js'
import { Transaction } from '../models/Transaction.js'
import { constructWebhookEvent } from '../services/stripe.service.js'
import { emitToAdmins, emitToMerchant, emitToReseller, WS_EVENTS } from '../services/socket.service.js'

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature'] as string | undefined
  const resellerId = String(req.params.resellerId || 'admin_root').trim()

  if (!signature) {
    res.status(400).json({ error: 'Missing stripe-signature header' })
    return
  }

  // 1. Fetch Reseller Webhook Secret
  let resellerConfig = await ResellerConfig.findOne({ resellerId })
  if (!resellerConfig || !resellerConfig.stripe?.webhookSecret) {
    resellerConfig = await ResellerConfig.findOne({ resellerId: 'admin_root' })
  }

  if (!resellerConfig || !resellerConfig.stripe?.webhookSecret) {
    console.warn(`[Stripe Webhook] Webhook secret not configured for reseller: ${resellerId}`)
    res.status(400).json({ error: 'Stripe webhook secret is not configured.' })
    return
  }

  let event: Stripe.Event
  try {
    const rawBody = (req as any).rawBody || req.body
    event = constructWebhookEvent(rawBody, signature, resellerConfig.stripe.webhookSecret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown signature failure'
    console.error(`[Stripe Webhook] Signature verification failed: ${message}`)
    res.status(400).send(`Webhook Error: ${message}`)
    return
  }

  // 2. Webhook Replay / Idempotency Check
  const existingTxn = await Transaction.findOne({ stripeEventId: event.id })
  if (existingTxn) {
    console.log(`[Stripe Webhook] Duplicate event ${event.id} already processed. Skipping idempotently.`)
    res.status(200).json({ received: true, duplicate: true })
    return
  }

  // 3. Process Payment Completion Events
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    await processSuccessfulCheckout(session, event.id, resellerConfig)
  } else if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    console.log(`[Stripe Webhook] PaymentIntent succeeded: ${paymentIntent.id}`)
  }

  res.status(200).json({ received: true })
}

async function processSuccessfulCheckout(
  session: Stripe.Checkout.Session,
  eventId: string,
  resellerConfig: InstanceType<typeof ResellerConfig>
) {
  const metadata = session.metadata || {}
  const merchantRefId = (metadata.merchant_ref_id || '').toUpperCase().trim()
  const resellerId = metadata.reseller_id || resellerConfig.resellerId || 'admin_root'
  const orderId = metadata.order_id || ''

  if (!merchantRefId) {
    console.warn(`[Stripe Webhook] Checkout completed without merchant_ref_id in metadata: ${session.id}`)
    return
  }

  const merchant = await Merchant.findOne({ refId: merchantRefId })
  if (!merchant) {
    console.warn(`[Stripe Webhook] Merchant with refId ${merchantRefId} not found in database.`)
    return
  }

  const grossCents = session.amount_total || 0
  const grossAmount = grossCents / 100
  const currency = (session.currency || 'USD').toUpperCase()

  // --- Financial Calculation Engine (Integer-Cent Precision) ---
  // 1. Hardwired 9% Platform Fee for Super Admin
  const platformFeeRate = 9.0
  const platformFeeCents = Math.round(grossCents * (platformFeeRate / 100))
  const platformFeeAmount = platformFeeCents / 100

  // 2. Reseller Configured Rate (must be >= 9%)
  const resellerFeeRate = Math.max(9.0, resellerConfig.feeSettings?.merchantFeeRate || 12.0)
  const resellerFeeCents = Math.round(grossCents * (resellerFeeRate / 100))
  const resellerFeeAmount = resellerFeeCents / 100

  // 3. Reseller Net Profit Spread ($12 - $9 = $3)
  const resellerProfitCents = Math.max(0, resellerFeeCents - platformFeeCents)
  const resellerProfitAmount = resellerProfitCents / 100

  // 4. Sub-Merchant Net Balance ($100 - $12 = $88)
  const merchantNetCents = Math.max(0, grossCents - resellerFeeCents)
  const merchantNetAmount = merchantNetCents / 100

  // Generate readable unique transaction ID
  const txnIdSuffix = crypto.randomBytes(3).toString('hex').toUpperCase()
  const transactionId = `TXN_PGX_${Date.now().toString().slice(-4)}_${txnIdSuffix}`

  // Save Transaction
  const transaction = await Transaction.create({
    transactionId,
    resellerId,
    merchantId: merchant._id,
    merchantRefId,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
    stripeSessionId: session.id,
    stripeEventId: eventId,
    currency,
    grossAmount,
    grossCents,
    platformFeeRate,
    platformFeeAmount,
    platformFeeCents,
    resellerFeeRate,
    resellerFeeAmount,
    resellerFeeCents,
    resellerProfitAmount,
    resellerProfitCents,
    merchantNetAmount,
    merchantNetCents,
    status: 'succeeded',
    customerEmail: session.customer_details?.email || undefined,
    customerName: session.customer_details?.name || undefined,
    orderId,
    metadata,
  })

  // Update Merchant Balances
  await Merchant.findByIdAndUpdate(merchant._id, {
    $inc: {
      'balance.grossVolume': grossAmount,
      'balance.netBalance': merchantNetAmount,
      'balance.totalFeesPaid': resellerFeeAmount,
    },
  })

  // Update Reseller Balances
  await ResellerConfig.findByIdAndUpdate(resellerConfig._id, {
    $inc: {
      totalVolumeProcessed: grossAmount,
      totalPlatformFeesEarned: platformFeeAmount,
      totalResellerProfit: resellerProfitAmount,
    },
  })

  console.log(
    `[Stripe Webhook] Transaction processed: ${transactionId} | Gross: $${grossAmount} | 9% Platform: $${platformFeeAmount} | Reseller Profit: $${resellerProfitAmount} | Merchant Net: $${merchantNetAmount}`
  )

  // Real-time WebSocket Dispatches
  const payload = {
    transactionId: transaction.transactionId,
    merchantRefId: transaction.merchantRefId,
    merchantName: merchant.legalName || merchant.fullName,
    grossAmount: transaction.grossAmount,
    platformFeeAmount: transaction.platformFeeAmount,
    resellerProfitAmount: transaction.resellerProfitAmount,
    merchantNetAmount: transaction.merchantNetAmount,
    currency: transaction.currency,
    status: transaction.status,
    customerEmail: transaction.customerEmail,
    createdAt: transaction.createdAt,
  }

  // 1. Send to Admin / Reseller
  emitToReseller(resellerId, WS_EVENTS.TRANSACTION_NEW, payload)

  // 2. Send to Super Admin
  emitToAdmins(WS_EVENTS.PLATFORM_TRANSACTION_NEW, payload)

  // 3. Send to Sub-Merchant
  emitToMerchant(merchant._id.toString(), WS_EVENTS.MERCHANT_CREDIT, {
    transactionId: transaction.transactionId,
    grossAmount: transaction.grossAmount,
    merchantNetAmount: transaction.merchantNetAmount,
    feeDeducted: transaction.resellerFeeAmount,
    status: transaction.status,
    createdAt: transaction.createdAt,
  })
}
