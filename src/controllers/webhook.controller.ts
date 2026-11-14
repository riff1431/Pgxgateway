import { Request, Response } from 'express'
import crypto from 'crypto'
import type Stripe from 'stripe'
import { config } from '../config/env.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { SystemConfig } from '../models/SystemConfig.js'
import { Merchant } from '../models/Merchant.js'
import { Transaction } from '../models/Transaction.js'
import { Notification } from '../models/Notification.js'
import { constructWebhookEvent } from '../services/stripe.service.js'
import { emitToAdmins, emitToMerchant, emitToReseller, WS_EVENTS } from '../services/socket.service.js'

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature'] as string | undefined
  const resellerId = String(req.params.resellerId || 'admin_root').trim()

  if (!signature) {
    res.status(400).json({ error: 'Missing stripe-signature header' })
    return
  }

  // 1. Fetch Webhook Secret (Reseller or Super Admin SystemConfig)
  let webhookSecret = ''
  let resellerConfig: any = null
  const sysConfig = await SystemConfig.findOne()

  if (resellerId === 'super-admin' || resellerId === 'super_admin' || resellerId === 'platform') {
    webhookSecret = sysConfig?.stripe?.webhookSecret || ''
  } else {
    resellerConfig = await ResellerConfig.findOne({ resellerId })
    if (!resellerConfig || !resellerConfig.stripe?.webhookSecret) {
      resellerConfig = await ResellerConfig.findOne({ resellerId: 'admin_root' })
    }
    webhookSecret = resellerConfig?.stripe?.webhookSecret || sysConfig?.stripe?.webhookSecret || ''
  }

  if (!webhookSecret) {
    console.warn(`[Stripe Webhook] Webhook secret not configured for target: ${resellerId}`)
    res.status(400).json({ error: 'Stripe webhook secret is not configured.' })
    return
  }

  let event: Stripe.Event
  try {
    const rawBody = req.rawBody || req.body
    event = constructWebhookEvent(rawBody, signature, webhookSecret)
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
    if (session.metadata?.type === 'setup_fee') {
      await processSetupFeeCheckout(session, event.id)
    } else {
      await processSuccessfulCheckout(session, event.id, resellerConfig)
    }
  } else if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    console.log(`[Stripe Webhook] PaymentIntent succeeded: ${paymentIntent.id}`)
  }

  res.status(200).json({ received: true })
}

async function processSetupFeeCheckout(session: Stripe.Checkout.Session, eventId: string) {
  const metadata = session.metadata || {}
  const merchantId = metadata.merchantId
  if (!merchantId) {
    console.warn(`[Stripe Webhook] Setup fee checkout completed without merchantId in metadata: ${session.id}`)
    return
  }

  const merchant = await Merchant.findById(merchantId)
  if (!merchant) {
    console.warn(`[Stripe Webhook] Merchant with ID ${merchantId} not found in database for setup fee.`)
    return
  }

  const amountTotal = (session.amount_total || 0) / 100
  merchant.setupStatus = 'paid_setup'
  merchant.setupFeeAmount = amountTotal
  merchant.setupPaidAt = new Date()
  merchant.setupStripeSessionId = session.id

  // Initialize 30-Day Recurring Monthly Maintenance Subscription
  const customerId = (typeof session.customer === 'string' ? session.customer : session.customer?.id) || metadata.customerId || merchant.subscription?.stripeCustomerId
  let monthlyFee = 99.0
  if (merchant.offer?.monthlyFee) {
    const parsed = parseFloat(String(merchant.offer.monthlyFee).replace(/[^0-9.]/g, ''))
    if (!isNaN(parsed) && parsed > 0) monthlyFee = parsed
  }

  merchant.subscription = {
    status: 'active',
    monthlyFee,
    nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-Day billing cycle
    lastBilledDate: new Date(),
    stripeCustomerId: customerId,
    autoRenew: true,
    failureCount: 0,
  }

  // Credit affiliate commission to referring reseller (if any)
  if (merchant.resellerId && merchant.resellerId !== 'admin_root') {
    const sysConfig = await SystemConfig.findOne()
    const rate = sysConfig?.affiliateCommissionRate ?? 20.0
    const commission = Math.round(((amountTotal * rate) / 100) * 100) / 100
    merchant.affiliateCommissionEarned = commission

    await ResellerConfig.findOneAndUpdate(
      { resellerId: merchant.resellerId },
      { $inc: { prepaidBalance: commission, totalResellerProfit: commission } }
    )
    console.log(`[Stripe Webhook] Credited $${commission} affiliate commission to reseller ${merchant.resellerId}`)
  }

  await merchant.save()

  // Save Transaction log for setup fee
  const txnIdSuffix = crypto.randomBytes(3).toString('hex').toUpperCase()
  await Transaction.create({
    transactionId: `TXN_SETUP_${Date.now().toString().slice(-4)}_${txnIdSuffix}`,
    resellerId: merchant.resellerId || 'admin_root',
    merchantId: merchant._id,
    merchantRefId: merchant.refId || String(merchant._id),
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
    stripeSessionId: session.id,
    stripeEventId: eventId,
    currency: (session.currency || 'USD').toUpperCase(),
    grossAmount: amountTotal,
    platformFeeAmount: amountTotal, // Platform received setup fee
    resellerSpreadAmount: merchant.affiliateCommissionEarned || 0,
    merchantNetAmount: 0,
    status: 'succeeded',
    customerEmail: session.customer_email || merchant.businessEmail,
    orderId: metadata.order_id || `SETUP-${merchant._id.toString().slice(-6).toUpperCase()}`,
  })

  // Notifications
  await Notification.create({
    merchantId: merchant._id,
    title: 'Setup Payment Verified!',
    content: `We received your setup payment of $${amountTotal}. The GitHub collaboration and configuration desk is now unlocked.`,
    type: 'system',
  })

  emitToMerchant(String(merchant._id), 'setup_paid', {
    setupStatus: 'paid_setup',
    setupFeeAmount: amountTotal,
  })

  emitToAdmins(WS_EVENTS.PAYMENT_RECEIVED, {
    merchantId: merchant._id,
    fullName: merchant.fullName,
    amount: amountTotal,
    type: 'setup_fee',
  })

  console.log(`[Stripe Webhook] Setup fee of $${amountTotal} successfully processed for merchant ${merchant.fullName} (${merchant._id}).`)
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
  // Tier-aware wholesale rate, hold, and rolling reserve (ARXO Blueprint)
  const isArxoReseller = resellerId === 'ARXO' || String(merchant.resellerId) === 'ARXO'
  const merchantTier = merchant.offer?.tier === 2 ? 2 : 1
  let platformFeeRate = resellerConfig.feeSettings?.basePlatformFee ?? 9.0
  let holdDays = 14
  let reserveRate = 10.0
  let reserveDays = 60

  if (isArxoReseller) {
    if (merchantTier === 2) {
      platformFeeRate = 12.0
      holdDays = 30
      reserveRate = 20.0
      reserveDays = 90
    } else {
      platformFeeRate = 9.0
      holdDays = 14
      reserveRate = 10.0
      reserveDays = 60
    }
  }

  // Parse merchant's assigned rate (e.g. from offer.rate "15%")
  let merchantConfiguredRate = resellerConfig.feeSettings?.merchantFeeRate || 12.0
  if (merchant.offer?.rate) {
    const parsedRate = parseFloat(String(merchant.offer.rate).replace(/[^0-9.]/g, ''))
    if (!isNaN(parsedRate) && parsedRate >= platformFeeRate) {
      merchantConfiguredRate = parsedRate
    }
  }

  const resellerFeeRate = Math.max(platformFeeRate, merchantConfiguredRate)
  const platformFeeCents = Math.round(grossCents * (platformFeeRate / 100))
  const platformFeeAmount = platformFeeCents / 100

  const resellerFeeCents = Math.round(grossCents * (resellerFeeRate / 100))
  const resellerFeeAmount = resellerFeeCents / 100

  const resellerProfitCents = Math.max(0, resellerFeeCents - platformFeeCents)
  const resellerProfitAmount = resellerProfitCents / 100

  const reserveCents = Math.round(grossCents * (reserveRate / 100))
  const reserveAmount = reserveCents / 100

  const merchantNetCents = Math.max(0, grossCents - resellerFeeCents)
  const merchantNetAmount = merchantNetCents / 100

  const settlementEligibleAt = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000)
  const rollingReserveReleaseAt = new Date(Date.now() + reserveDays * 24 * 60 * 60 * 1000)

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
    tier: merchantTier,
    settlementHoldDays: holdDays,
    settlementEligibleAt,
    rollingReserveRate: reserveRate,
    rollingReserveAmount: reserveAmount,
    rollingReserveReleaseAt,
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

/**
 * Handles verified server-to-server settlement webhooks from PGX Digital E-Commerce (pgxdigital.shop).
 * Credits the merchant's MongoDB ledger and executes multi-tenant fee distributions.
 */
export async function handleGatewaySettlementWebhook(req: Request, res: Response): Promise<void> {
  const secretHeader =
    (req.headers['x-gateway-bridge-secret'] as string) ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : '')

  if (!secretHeader || secretHeader.trim() !== (config.ecomBridge?.secret || '').trim()) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing gateway bridge secret' })
    return
  }

  const {
    stripeSessionId,
    stripeEventId,
    merchantRefId,
    resellerId = 'admin_root',
    orderId = '',
    grossAmount,
    currency = 'USD',
    customerEmail,
    customerName,
    metadata = {},
  } = req.body

  if (!merchantRefId || typeof grossAmount !== 'number') {
    res.status(400).json({ error: 'Missing required settlement parameters (merchantRefId, grossAmount)' })
    return
  }

  // Idempotency check
  const existingTxn = await Transaction.findOne({
    $or: [{ stripeSessionId }, ...(stripeEventId ? [{ stripeEventId }] : [])],
  })

  if (existingTxn) {
    console.log(`[Gateway Settlement] Duplicate event ${stripeSessionId} already processed.`)
    res.status(200).json({ received: true, duplicate: true, transactionId: existingTxn.transactionId })
    return
  }

  const merchant = await Merchant.findOne({ refId: merchantRefId.toUpperCase().trim() })
  if (!merchant) {
    console.warn(`[Gateway Settlement] Merchant with refId ${merchantRefId} not found in database.`)
    res.status(404).json({ error: `Merchant ${merchantRefId} not found` })
    return
  }

  let resellerConfig = await ResellerConfig.findOne({ resellerId })
  if (!resellerConfig) {
    resellerConfig = await ResellerConfig.findOne({ resellerId: 'admin_root' })
  }

  const grossCents = Math.round(grossAmount * 100)
  const normCurrency = String(currency).toUpperCase()

  // Dynamic fee calculation (Tier-aware for ARXO)
  const isArxoReseller = resellerId === 'ARXO' || String(merchant.resellerId) === 'ARXO'
  const merchantTier = merchant.offer?.tier === 2 ? 2 : 1
  let platformFeeRate = resellerConfig?.feeSettings?.basePlatformFee ?? 9.0
  let holdDays = 14
  let reserveRate = 10.0
  let reserveDays = 60

  if (isArxoReseller) {
    if (merchantTier === 2) {
      platformFeeRate = 12.0
      holdDays = 30
      reserveRate = 20.0
      reserveDays = 90
    } else {
      platformFeeRate = 9.0
      holdDays = 14
      reserveRate = 10.0
      reserveDays = 60
    }
  }

  let merchantConfiguredRate = resellerConfig?.feeSettings?.merchantFeeRate || 12.0
  if (merchant.offer?.rate) {
    const parsedRate = parseFloat(String(merchant.offer.rate).replace(/[^0-9.]/g, ''))
    if (!isNaN(parsedRate) && parsedRate >= platformFeeRate) {
      merchantConfiguredRate = parsedRate
    }
  }

  const resellerFeeRate = Math.max(platformFeeRate, merchantConfiguredRate)
  const platformFeeCents = Math.round(grossCents * (platformFeeRate / 100))
  const platformFeeAmount = platformFeeCents / 100

  const resellerFeeCents = Math.round(grossCents * (resellerFeeRate / 100))
  const resellerFeeAmount = resellerFeeCents / 100

  const resellerProfitCents = Math.max(0, resellerFeeCents - platformFeeCents)
  const resellerProfitAmount = resellerProfitCents / 100

  const reserveCents = Math.round(grossCents * (reserveRate / 100))
  const reserveAmount = reserveCents / 100

  const merchantNetCents = Math.max(0, grossCents - resellerFeeCents)
  const merchantNetAmount = merchantNetCents / 100

  const settlementEligibleAt = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000)
  const rollingReserveReleaseAt = new Date(Date.now() + reserveDays * 24 * 60 * 60 * 1000)

  const txnIdSuffix = crypto.randomBytes(3).toString('hex').toUpperCase()
  const transactionId = `TXN_ECOM_${Date.now().toString().slice(-4)}_${txnIdSuffix}`

  const transaction = await Transaction.create({
    transactionId,
    resellerId,
    merchantId: merchant._id,
    merchantRefId: merchant.refId,
    stripeSessionId,
    stripeEventId,
    currency: normCurrency,
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
    tier: merchantTier,
    settlementHoldDays: holdDays,
    settlementEligibleAt,
    rollingReserveRate: reserveRate,
    rollingReserveAmount: reserveAmount,
    rollingReserveReleaseAt,
    status: 'succeeded',
    customerEmail,
    customerName,
    orderId,
    metadata: {
      ...metadata,
      settlement_channel: 'pgx_digital_ecom',
    },
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
  if (resellerConfig) {
    await ResellerConfig.findByIdAndUpdate(resellerConfig._id, {
      $inc: {
        totalVolumeProcessed: grossAmount,
        totalPlatformFeesEarned: platformFeeAmount,
        totalResellerProfit: resellerProfitAmount,
      },
    })
  }

  console.log(
    `[Gateway Settlement] Succeeded: ${transactionId} for merchant ${merchant.refId} | Gross: $${grossAmount} | Net: $${merchantNetAmount}`
  )

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

  // Real-time WebSocket Dispatches
  emitToReseller(resellerId, WS_EVENTS.TRANSACTION_NEW, payload)
  emitToAdmins(WS_EVENTS.PLATFORM_TRANSACTION_NEW, payload)
  emitToMerchant(merchant._id.toString(), WS_EVENTS.MERCHANT_CREDIT, {
    transactionId: transaction.transactionId,
    grossAmount: transaction.grossAmount,
    merchantNetAmount: transaction.merchantNetAmount,
    feeDeducted: transaction.resellerFeeAmount,
    status: transaction.status,
    createdAt: transaction.createdAt,
  })

  res.status(200).json({
    success: true,
    transactionId,
    grossAmount,
    merchantNetAmount,
  })
}
