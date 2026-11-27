import { Request, Response } from 'express'
import crypto from 'crypto'
import type Stripe from 'stripe'
import { config } from '../config/env.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { SystemConfig } from '../models/SystemConfig.js'
import { Merchant } from '../models/Merchant.js'
import { Invoice } from '../models/Invoice.js'
import { PaymentLink } from '../models/PaymentLink.js'
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
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session
    if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      console.log(`[Stripe Webhook] Session ${session.id} has payment_status=${session.payment_status}; awaiting async settlement.`)
      res.status(200).json({ received: true, pendingAsync: true })
      return
    }
    if (session.metadata?.type === 'setup_fee') {
      await processSetupFeeCheckout(session, event.id)
    } else if (session.metadata?.type === 'weekly_invoice') {
      await processWeeklyInvoiceSettlement({
        invoiceId: session.metadata?.invoiceId,
        stripeSessionId: session.id,
        stripeEventId: event.id,
        grossAmount: (session.amount_total || 0) / 100,
        currency: (session.currency || 'USD').toUpperCase(),
        customerEmail: session.customer_details?.email || session.customer_email || undefined,
      })
    } else {
      await processSuccessfulCheckout(session, event.id, resellerConfig)
    }
  } else if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    console.log(`[Stripe Webhook] PaymentIntent succeeded: ${paymentIntent.id}`)
  } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    const session = event.data.object as Stripe.Checkout.Session
    const failureReason =
      event.type === 'checkout.session.expired'
        ? 'Checkout session expired without payment'
        : 'Async payment failed in Stripe'
    await markTransactionFailed({
      stripeSessionId: session.id,
      stripeEventId: event.id,
      merchantRefId: session.metadata?.merchantRefId || session.metadata?.cid,
      resellerId: session.metadata?.resellerId || session.metadata?.rid || 'admin_root',
      orderId: session.metadata?.orderId || session.metadata?.oid,
      grossAmount: (session.amount_total || 0) / 100,
      currency: (session.currency || 'USD').toUpperCase(),
      customerEmail: session.customer_details?.email || session.customer_email || undefined,
      customerName: session.customer_details?.name || undefined,
      failureReason,
      declineCode: event.type,
    })
  } else if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    const lastErr = paymentIntent.last_payment_error
    const failureReason = lastErr?.message || 'Card payment declined or blocked by Stripe'
    const declineCode = lastErr?.decline_code || lastErr?.code || 'payment_failed'
    await markTransactionFailed({
      stripePaymentIntentId: paymentIntent.id,
      stripeEventId: event.id,
      merchantRefId: paymentIntent.metadata?.merchantRefId || paymentIntent.metadata?.cid,
      resellerId: paymentIntent.metadata?.resellerId || paymentIntent.metadata?.rid || 'admin_root',
      orderId: paymentIntent.metadata?.orderId || paymentIntent.metadata?.oid,
      grossAmount: (paymentIntent.amount || 0) / 100,
      currency: (paymentIntent.currency || 'USD').toUpperCase(),
      customerEmail: paymentIntent.receipt_email || undefined,
      failureReason,
      declineCode,
    })
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
  merchant.accountMode = 'live'
  if (merchant.trial) {
    merchant.trial.isActive = false
    merchant.trial.status = 'converted'
  }
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
  const merchantRefId = (metadata.merchant_ref_id || metadata.cid || '').toUpperCase().trim()
  const resellerId = metadata.reseller_id || (metadata.rid === 'PRT-ARX-01' ? 'ARXO' : null) || resellerConfig.resellerId || 'admin_root'
  const orderId = metadata.order_id || metadata.oid || ''

  if (!merchantRefId) {
    console.warn(`[Stripe Webhook] Checkout completed without merchantRefId (cid) in metadata: ${session.id}`)
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
      platformFeeRate = 15.0
      holdDays = 45
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
    settlementStatus: 'on_hold',
    rollingReserveRate: reserveRate,
    rollingReserveAmount: reserveAmount,
    rollingReserveReleaseAt,
    rollingReserveStatus: 'locked',
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
    productName: transaction.productName,
    cloakedProductName: transaction.cloakedProductName,
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

  // 4. Dispatch Outbound Server-to-Server Webhook to Merchant WooCommerce / Website
  await dispatchMerchantWebhook(merchant, transaction, orderId)
}

async function dispatchMerchantWebhook(merchant: any, txn: any, rawOrderId: string) {
  const targetUrl = merchant.webhookUrl || txn.metadata?.webhookUrl
  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) return

  const webhookSecret = merchant.webhookSecret || config.ecomBridge?.secret || 'pgx_secret'
  const timestamp = Math.floor(Date.now() / 1000)
  const cleanOrderNum = String(rawOrderId || txn.orderId || '').replace(/\D/g, '').slice(-4)
  const resolvedRef = txn.paymentRef || (cleanOrderNum ? `pgx_${cleanOrderNum}` : undefined)
  const isFailed = txn.status === 'failed'

  const payload = {
    event: isFailed ? 'payment.failed' : 'payment.completed',
    status: isFailed ? 'failed' : 'completed',
    transactionId: txn.transactionId,
    paymentRef: resolvedRef,
    sessionId: resolvedRef,
    orderId: rawOrderId || txn.orderId,
    merchantId: String(merchant._id),
    merchantRefId: merchant.refId,
    grossAmount: txn.grossAmount,
    netAmount: isFailed ? 0 : txn.merchantNetAmount,
    feeAmount: isFailed
      ? 0
      : Number(((txn.platformFeeAmount || 0) + (txn.resellerSpreadAmount || txn.resellerProfitAmount || 0)).toFixed(2)),
    currency: txn.currency,
    paymentMethod: 'card',
    failureReason: isFailed ? (txn.metadata?.failureReason as string | undefined) : undefined,
    timestamp,
    metadata: {
      source: 'woocommerce',
      ...(txn.metadata || {}),
    },
  }

  const rawPayload = JSON.stringify(payload)
  const signature = crypto.createHmac('sha256', webhookSecret).update(`${timestamp}.${rawPayload}`).digest('hex')

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PGX-Signature': signature,
        'X-PGX-Timestamp': String(timestamp),
        'User-Agent': 'PGX-Gateway-Webhook/1.0',
      },
      body: rawPayload,
      signal: AbortSignal.timeout(10000),
    })
    console.log(`[Merchant Webhook] Dispatched to ${targetUrl} for order ${rawOrderId}: HTTP ${res.status}`)
  } catch (err: any) {
    console.warn(`[Merchant Webhook] Failed to deliver webhook to ${targetUrl}: ${err.message}`)
  }
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

  const incomingSecret = (secretHeader || '').trim()
  const allowedSecrets = [
    config.bridges?.marketplace?.secret?.trim(),
    config.bridges?.leads?.secret?.trim(),
    config.ecomBridge?.secret?.trim(),
  ].filter(Boolean) as string[]

  if (!incomingSecret || !allowedSecrets.includes(incomingSecret)) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing gateway bridge secret' })
    return
  }

  // Detect bridgeProfile
  let detectedBridge: 'marketplace' | 'leads' = 'marketplace'
  if (config.bridges?.leads?.secret && incomingSecret === config.bridges.leads.secret.trim()) {
    detectedBridge = 'leads'
  } else if (req.body.bridgeProfile === 'leads' || req.body.bridgeProfile === 'marketplace') {
    detectedBridge = req.body.bridgeProfile
  }

  const {
    status: incomingStatus = 'succeeded',
    stripeSessionId,
    stripePaymentIntentId,
    stripeEventId,
    merchantRefId,
    resellerId = 'admin_root',
    orderId = '',
    grossAmount,
    currency = 'USD',
    customerEmail,
    customerName,
    cloakedProductName,
    realProductName,
    failureReason,
    declineCode,
    metadata = {},
  } = req.body

  if (incomingStatus === 'failed') {
    const result = await markTransactionFailed({
      stripeSessionId,
      stripePaymentIntentId,
      stripeEventId,
      merchantRefId,
      resellerId,
      orderId,
      grossAmount: typeof grossAmount === 'number' ? grossAmount : 0,
      currency,
      customerEmail,
      customerName,
      cloakedProductName,
      realProductName,
      bridgeProfile: detectedBridge,
      failureReason,
      declineCode,
      metadata,
    })

    res.status(200).json({ received: true, ...result })
    return
  }

  if (!merchantRefId || typeof grossAmount !== 'number') {
    res.status(400).json({ error: 'Missing required settlement parameters (merchantRefId, grossAmount)' })
    return
  }

  // Idempotency check
  const existingTxn = await Transaction.findOne({
    $or: [{ stripeSessionId }, ...(stripeEventId ? [{ stripeEventId }] : [])],
  })

  if (existingTxn && existingTxn.status === 'succeeded') {
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

  const normCurrency = String(currency).toUpperCase()

  // Check if this settlement is a Setup Fee payment through the E-Commerce Bridge
  const effectiveOrderId = existingTxn?.orderId || orderId
  const effectiveType = existingTxn?.metadata?.type || metadata?.type
  const isSetupFee =
    (effectiveOrderId && String(effectiveOrderId).startsWith('SETUP-')) ||
    effectiveType === 'setup_fee' ||
    Boolean(merchant.setupStripeSessionId && merchant.setupStripeSessionId === stripeSessionId)

  if (isSetupFee) {
    console.log(`[Gateway Settlement] Processing Setup Fee via bridge for merchant ${merchant.fullName} (${merchant.refId})`)

    merchant.setupStatus = 'information_pending'
    merchant.accountMode = 'live'
    if (merchant.trial) {
      merchant.trial.isActive = false
      merchant.trial.status = 'converted'
    }
    merchant.setupFeeAmount = grossAmount
    merchant.setupPaidAt = new Date()
    merchant.setupStripeSessionId = stripeSessionId

    // 30-Day Recurring Maintenance Subscription
    let monthlyFee = 99.0
    if (merchant.offer?.monthlyFee) {
      const parsed = parseFloat(String(merchant.offer.monthlyFee).replace(/[^0-9.]/g, ''))
      if (!isNaN(parsed) && parsed > 0) monthlyFee = parsed
    }
    merchant.subscription = {
      status: 'active',
      monthlyFee,
      nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lastBilledDate: new Date(),
      autoRenew: true,
      failureCount: 0,
    }

    // Accrue 20% affiliate commission to reseller
    if (merchant.resellerId && merchant.resellerId !== 'admin_root') {
      const sysConfig = await SystemConfig.findOne()
      const rate = sysConfig?.affiliateCommissionRate ?? 20.0
      const commission = Math.round(((grossAmount * rate) / 100) * 100) / 100
      merchant.affiliateCommissionEarned = commission

      await ResellerConfig.findOneAndUpdate(
        { resellerId: merchant.resellerId },
        { $inc: { prepaidBalance: commission, totalResellerProfit: commission } }
      )
    }

    await merchant.save()

    // Transaction log
    const txnIdSuffix = crypto.randomBytes(3).toString('hex').toUpperCase()
    const activeBridgeProfile = detectedBridge || merchant.assignedBridge || 'marketplace'
    const setupCleanNum = String(orderId || '').replace(/\D/g, '').slice(-4) || Date.now().toString().slice(-4)
    const setupPaymentRef = `pgx_${setupCleanNum}`

    if (existingTxn) {
      await Transaction.deleteOne({ _id: existingTxn._id })
    }

    const setupTxn = await Transaction.create({
      transactionId: `TXN_SETUP_${Date.now().toString().slice(-4)}_${txnIdSuffix}`,
      resellerId: merchant.resellerId || 'admin_root',
      merchantId: merchant._id,
      merchantRefId: merchant.refId || String(merchant._id),
      bridgeProfile: activeBridgeProfile,
      stripeSessionId,
      stripeEventId,
      paymentRef: setupPaymentRef,
      currency: normCurrency,
      grossAmount,
      platformFeeAmount: grossAmount,
      resellerSpreadAmount: merchant.affiliateCommissionEarned || 0,
      merchantNetAmount: 0,
      status: 'succeeded',
      customerEmail: customerEmail || merchant.businessEmail,
      orderId,
      description: 'E-Commerce Bridge Setup & Integration License',
    })

    // Notifications
    await Notification.create({
      merchantId: merchant._id,
      title: 'Setup Fee Paid via E-Commerce Bridge!',
      content: `Setup payment of $${grossAmount} confirmed via PGX Digital. Account is now live.`,
      type: 'system',
    })

    emitToMerchant(String(merchant._id), 'setup_status_updated', {
      setupStatus: merchant.setupStatus,
      accountMode: merchant.accountMode,
    })

    emitToAdmins(WS_EVENTS.PAYMENT_RECEIVED, {
      merchantId: merchant._id,
      fullName: merchant.fullName,
      amount: grossAmount,
      type: 'setup_fee',
    })

    res.status(200).json({ received: true, setupFeeProcessed: true, transactionId: setupTxn.transactionId })
    return
  }

  // Check if this settlement is a Weekly Invoice payment through the E-Commerce Bridge
  const isWeeklyInvoice =
    effectiveType === 'weekly_invoice' ||
    (effectiveOrderId && String(effectiveOrderId).startsWith('INV-'))

  if (isWeeklyInvoice) {
    const invoiceResult = await processWeeklyInvoiceSettlement({
      invoiceId: existingTxn?.metadata?.invoiceId || metadata?.invoiceId,
      invoiceNumber: effectiveOrderId,
      stripeSessionId,
      stripeEventId,
      grossAmount,
      currency: normCurrency,
      customerEmail: customerEmail || merchant.businessEmail,
      bridgeProfile: detectedBridge || merchant.assignedBridge || 'marketplace',
      existingTxn,
    })

    if (invoiceResult) {
      res.status(200).json({ received: true, invoiceProcessed: true, ...invoiceResult })
      return
    }
  }

  let resellerConfig = await ResellerConfig.findOne({ resellerId })
  if (!resellerConfig) {
    resellerConfig = await ResellerConfig.findOne({ resellerId: 'admin_root' })
  }

  const grossCents = Math.round(grossAmount * 100)

  // Dynamic fee calculation (Tier-aware for ARXO)
  const isArxoReseller = resellerId === 'ARXO' || String(merchant.resellerId) === 'ARXO'
  const merchantTier = merchant.offer?.tier === 2 ? 2 : 1
  let platformFeeRate = resellerConfig?.feeSettings?.basePlatformFee ?? 9.0
  let holdDays = 14
  let reserveRate = 10.0
  let reserveDays = 60

  if (isArxoReseller) {
    if (merchantTier === 2) {
      platformFeeRate = 15.0
      holdDays = 45
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
  const activeBridgeProfile = detectedBridge || merchant.assignedBridge || 'marketplace'
  const cleanOrderNum = String(orderId || '').replace(/\D/g, '').slice(-4) || Date.now().toString().slice(-4)
  const resolvedPaymentRef = `pgx_${cleanOrderNum}`

  let transaction: any
  if (existingTxn && (existingTxn.status === 'pending' || existingTxn.status === 'failed')) {
    existingTxn.transactionId = transactionId
    existingTxn.status = 'succeeded'
    existingTxn.stripeEventId = stripeEventId
    existingTxn.grossCents = grossCents
    existingTxn.grossAmount = grossAmount
    existingTxn.platformFeeRate = platformFeeRate
    existingTxn.platformFeeAmount = platformFeeAmount
    existingTxn.platformFeeCents = platformFeeCents
    existingTxn.resellerFeeRate = resellerFeeRate
    existingTxn.resellerFeeAmount = resellerFeeAmount
    existingTxn.resellerFeeCents = resellerFeeCents
    existingTxn.resellerProfitAmount = resellerProfitAmount
    existingTxn.resellerProfitCents = resellerProfitCents
    existingTxn.merchantNetAmount = merchantNetAmount
    existingTxn.merchantNetCents = merchantNetCents
    existingTxn.tier = merchantTier
    existingTxn.settlementHoldDays = holdDays
    existingTxn.settlementEligibleAt = settlementEligibleAt
    existingTxn.settlementStatus = 'on_hold'
    existingTxn.rollingReserveRate = reserveRate
    existingTxn.rollingReserveAmount = reserveAmount
    existingTxn.rollingReserveReleaseAt = rollingReserveReleaseAt
    existingTxn.rollingReserveStatus = 'locked'
    existingTxn.customerEmail = customerEmail || existingTxn.customerEmail
    existingTxn.customerName = customerName || existingTxn.customerName
    existingTxn.orderId = orderId || existingTxn.orderId
    existingTxn.bridgeProfile = activeBridgeProfile
    if (!existingTxn.paymentRef) {
      existingTxn.paymentRef = resolvedPaymentRef
    }
    existingTxn.productName = realProductName || metadata?.realProductName || (orderId ? `Order #${orderId}` : 'Digital Goods')
    existingTxn.cloakedProductName = cloakedProductName || metadata?.cloakedSku || (activeBridgeProfile === 'leads' ? 'B2B Leads Package' : 'pgxdigital Software License')
    existingTxn.metadata = {
      ...(existingTxn.metadata || {}),
      ...metadata,
      settlement_channel: activeBridgeProfile === 'leads' ? 'pgx_leads_ecom' : 'pgx_digital_ecom',
    }
    await existingTxn.save()
    transaction = existingTxn
  } else {
    transaction = await Transaction.create({
      transactionId,
      resellerId,
      merchantId: merchant._id,
      merchantRefId: merchant.refId,
      bridgeProfile: activeBridgeProfile,
      stripeSessionId,
      stripeEventId,
      paymentRef: resolvedPaymentRef,
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
      settlementStatus: 'on_hold',
      rollingReserveRate: reserveRate,
      rollingReserveAmount: reserveAmount,
      rollingReserveReleaseAt,
      rollingReserveStatus: 'locked',
      status: 'succeeded',
      customerEmail,
      customerName,
      orderId,
      productName: realProductName || metadata?.realProductName || (orderId ? `Order #${orderId}` : 'Digital Goods'),
      cloakedProductName: cloakedProductName || metadata?.cloakedSku || (activeBridgeProfile === 'leads' ? 'B2B Leads Package' : 'pgxdigital Software License'),
      metadata: {
        ...metadata,
        settlement_channel: activeBridgeProfile === 'leads' ? 'pgx_leads_ecom' : 'pgx_digital_ecom',
      },
    })
  }

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

  // Update Payment Link metrics (and close one-time links upon settlement)
  const paymentLinkId = transaction.metadata?.paymentLinkId || metadata?.paymentLinkId
  if (paymentLinkId) {
    const linkDoc = await PaymentLink.findById(paymentLinkId)
    if (linkDoc) {
      linkDoc.totalPayments = (linkDoc.totalPayments || 0) + 1
      linkDoc.totalVolume = Math.round(((linkDoc.totalVolume || 0) + grossAmount) * 100) / 100
      linkDoc.lastPaidAt = new Date()
      if (!linkDoc.reusable) {
        linkDoc.status = 'completed'
      }
      await linkDoc.save()
    }
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
    productName: transaction.productName,
    cloakedProductName: transaction.cloakedProductName,
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

  // Outbound Server-to-Server Webhook to Merchant WooCommerce / Website
  await dispatchMerchantWebhook(merchant, transaction, orderId)

  res.status(200).json({
    success: true,
    transactionId,
    grossAmount,
    merchantNetAmount,
  })
}

async function processWeeklyInvoiceSettlement(params: {
  invoiceId?: string
  invoiceNumber?: string
  stripeSessionId: string
  stripeEventId?: string
  grossAmount: number
  currency: string
  customerEmail?: string
  bridgeProfile?: 'marketplace' | 'leads'
  existingTxn?: any
}) {
  const invoice = await Invoice.findOne(
    params.invoiceId
      ? { _id: params.invoiceId }
      : {
          $or: [
            { stripeSessionId: params.stripeSessionId },
            ...(params.invoiceNumber ? [{ invoiceNumber: params.invoiceNumber }] : []),
          ],
        }
  )

  if (!invoice) {
    console.warn(`[Invoice Settlement] Invoice not found for session ${params.stripeSessionId}`)
    return null
  }

  if (invoice.status !== 'paid') {
    invoice.status = 'paid'
    invoice.paidAt = new Date()
    invoice.paymentMethod = 'stripe'
    invoice.stripeSessionId = params.stripeSessionId
    await invoice.save()

    if (invoice.resellerId && invoice.resellerId !== 'admin_root' && invoice.resellerShareAmount > 0) {
      await ResellerConfig.findOneAndUpdate(
        { resellerId: invoice.resellerId },
        {
          $inc: {
            prepaidBalance: invoice.resellerShareAmount,
            totalResellerProfit: invoice.resellerShareAmount,
          },
        }
      )
    }

    await Notification.create({
      merchantId: invoice.merchantId,
      title: `Invoice ${invoice.invoiceNumber} Paid`,
      content: `Your invoice payment of $${params.grossAmount.toFixed(2)} ${params.currency} has been confirmed.`,
      type: 'system',
    })

    emitToMerchant(String(invoice.merchantId), 'invoice_status_updated', {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
    })

    emitToAdmins(WS_EVENTS.PAYMENT_RECEIVED, {
      merchantId: invoice.merchantId,
      amount: params.grossAmount,
      type: 'weekly_invoice',
      invoiceNumber: invoice.invoiceNumber,
    })
  }

  if (params.existingTxn) {
    await Transaction.deleteOne({ _id: params.existingTxn._id })
  }

  const txnIdSuffix = crypto.randomBytes(3).toString('hex').toUpperCase()
  const cleanInvNum = invoice.invoiceNumber.replace(/\D/g, '').slice(-4) || Date.now().toString().slice(-4)
  const merchant = await Merchant.findById(invoice.merchantId).select('refId')

  const invoiceTxn = await Transaction.create({
    transactionId: `TXN_INV_${Date.now().toString().slice(-4)}_${txnIdSuffix}`,
    resellerId: invoice.resellerId || 'admin_root',
    merchantId: invoice.merchantId,
    merchantRefId: merchant?.refId || String(invoice.merchantId),
    bridgeProfile: params.bridgeProfile || 'marketplace',
    stripeSessionId: params.stripeSessionId,
    stripeEventId: params.stripeEventId,
    paymentRef: `pgx_${cleanInvNum}`,
    currency: params.currency,
    grossAmount: params.grossAmount,
    platformFeeAmount: invoice.platformRetainedAmount || params.grossAmount,
    resellerSpreadAmount: invoice.resellerShareAmount || 0,
    merchantNetAmount: 0,
    status: 'succeeded',
    customerEmail: params.customerEmail || invoice.merchantEmail,
    orderId: invoice.invoiceNumber,
    description: `Weekly Service Invoice (${invoice.invoiceNumber})`,
  })

  return {
    transactionId: invoiceTxn.transactionId,
    invoiceNumber: invoice.invoiceNumber,
  }
}

export async function markTransactionFailed(params: {
  stripeSessionId?: string
  stripePaymentIntentId?: string
  stripeEventId?: string
  merchantRefId?: string
  resellerId?: string
  orderId?: string
  grossAmount?: number
  currency?: string
  customerEmail?: string
  customerName?: string
  cloakedProductName?: string
  realProductName?: string
  bridgeProfile?: 'marketplace' | 'leads'
  failureReason?: string
  declineCode?: string
  metadata?: Record<string, unknown>
}): Promise<{ updated: boolean; created?: boolean; alreadySettled?: boolean; transactionId?: string }> {
  const normRef = params.merchantRefId ? params.merchantRefId.toUpperCase().trim() : ''
  const rawOrderId = String(params.orderId || '').trim()
  const cleanDigits = rawOrderId.replace(/\D/g, '')
  const normalizedOrderId = cleanDigits.length >= 4 ? `ORD-${cleanDigits.slice(-4)}` : rawOrderId

  const orConditions: any[] = []
  if (params.stripeSessionId) {
    orConditions.push({ stripeSessionId: params.stripeSessionId })
  }
  if (params.stripePaymentIntentId) {
    orConditions.push({ stripePaymentIntentId: params.stripePaymentIntentId })
  }
  if (params.stripeEventId) {
    orConditions.push({ stripeEventId: params.stripeEventId })
  }

  let existingTxn =
    orConditions.length > 0
      ? await Transaction.findOne({ $or: orConditions }).sort({ createdAt: -1 })
      : null

  if (!existingTxn && normRef && normalizedOrderId) {
    existingTxn = await Transaction.findOne({
      merchantRefId: normRef,
      $or: [{ orderId: normalizedOrderId }, { orderId: rawOrderId }],
      status: { $in: ['pending', 'failed'] },
    }).sort({ createdAt: -1 })
  }

  if (existingTxn && (existingTxn.status === 'succeeded' || existingTxn.status === 'refunded')) {
    console.log(
      `[Gateway Failure] Ignoring failure event for already ${existingTxn.status} transaction ${existingTxn.transactionId}`,
    )
    return { updated: false, alreadySettled: true, transactionId: existingTxn.transactionId }
  }

  const merchant = normRef
    ? await Merchant.findOne({ refId: normRef })
    : existingTxn
      ? await Merchant.findById(existingTxn.merchantId)
      : null

  const resolvedReason = params.failureReason || 'Payment declined or blocked by Stripe'
  const resolvedCode = params.declineCode || 'payment_failed'
  const activeBridgeProfile = params.bridgeProfile || existingTxn?.bridgeProfile || merchant?.assignedBridge || 'marketplace'

  let transaction: any = existingTxn

  if (existingTxn) {
    existingTxn.status = 'failed'
    if (params.stripeSessionId && !existingTxn.stripeSessionId) {
      existingTxn.stripeSessionId = params.stripeSessionId
    }
    if (params.stripePaymentIntentId) {
      existingTxn.stripePaymentIntentId = params.stripePaymentIntentId
    }
    if (params.stripeEventId && !existingTxn.stripeEventId) {
      existingTxn.stripeEventId = params.stripeEventId
    }
    existingTxn.platformFeeAmount = 0
    existingTxn.platformFeeCents = 0
    existingTxn.resellerFeeAmount = 0
    existingTxn.resellerFeeCents = 0
    existingTxn.resellerProfitAmount = 0
    existingTxn.resellerProfitCents = 0
    existingTxn.merchantNetAmount = 0
    existingTxn.merchantNetCents = 0
    existingTxn.rollingReserveAmount = 0
    existingTxn.settlementStatus = undefined
    existingTxn.settlementEligibleAt = undefined
    existingTxn.rollingReserveStatus = undefined
    existingTxn.rollingReserveReleaseAt = undefined
    existingTxn.customerEmail = params.customerEmail || existingTxn.customerEmail
    existingTxn.customerName = params.customerName || existingTxn.customerName
    existingTxn.bridgeProfile = activeBridgeProfile
    existingTxn.metadata = {
      ...(existingTxn.metadata || {}),
      ...(params.metadata || {}),
      failureReason: resolvedReason,
      declineCode: resolvedCode,
      failedAt: new Date().toISOString(),
    }
    await existingTxn.save()
    transaction = existingTxn
  } else if (merchant && (params.grossAmount || 0) > 0) {
    const grossAmount = Number(params.grossAmount || 0)
    const grossCents = Math.round(grossAmount * 100)
    const txnIdSuffix = crypto.randomBytes(3).toString('hex').toUpperCase()
    const cleanNum = cleanDigits.slice(-4) || Date.now().toString().slice(-4)
    const resolvedPaymentRef = `pgx_${cleanNum}`
    const resellerId =
      params.resellerId && params.resellerId !== 'admin_root'
        ? params.resellerId
        : merchant.resellerId || 'admin_root'

    transaction = await Transaction.create({
      transactionId: `TXN_FAIL_${Date.now().toString().slice(-4)}_${txnIdSuffix}`,
      resellerId,
      merchantId: merchant._id,
      merchantRefId: merchant.refId,
      bridgeProfile: activeBridgeProfile,
      stripeSessionId: params.stripeSessionId,
      stripePaymentIntentId: params.stripePaymentIntentId,
      stripeEventId: params.stripeEventId,
      paymentRef: resolvedPaymentRef,
      currency: (params.currency || 'USD').toUpperCase(),
      grossAmount,
      grossCents,
      platformFeeRate: 9.0,
      platformFeeAmount: 0,
      platformFeeCents: 0,
      resellerFeeRate: 12.0,
      resellerFeeAmount: 0,
      resellerFeeCents: 0,
      resellerProfitAmount: 0,
      resellerProfitCents: 0,
      merchantNetAmount: 0,
      merchantNetCents: 0,
      status: 'failed',
      customerEmail: params.customerEmail,
      customerName: params.customerName,
      orderId: normalizedOrderId || undefined,
      productName: params.realProductName || (normalizedOrderId ? `Order #${cleanNum}` : 'Digital Goods'),
      cloakedProductName: params.cloakedProductName,
      metadata: {
        ...(params.metadata || {}),
        failureReason: resolvedReason,
        declineCode: resolvedCode,
        failedAt: new Date().toISOString(),
      },
    })
  } else {
    console.warn(
      `[Gateway Failure] No matching pending transaction or merchant found for session=${params.stripeSessionId || 'N/A'} pi=${params.stripePaymentIntentId || 'N/A'} ref=${normRef || 'N/A'}`,
    )
    return { updated: false }
  }

  const effectiveResellerId = String(transaction.resellerId || merchant?.resellerId || 'admin_root')
  const payload = {
    transactionId: transaction.transactionId,
    merchantRefId: transaction.merchantRefId,
    merchantName: merchant?.legalName || merchant?.fullName,
    grossAmount: transaction.grossAmount,
    platformFeeAmount: 0,
    resellerProfitAmount: 0,
    merchantNetAmount: 0,
    currency: transaction.currency,
    status: 'failed',
    failureReason: resolvedReason,
    declineCode: resolvedCode,
    customerEmail: transaction.customerEmail,
    productName: transaction.productName,
    createdAt: transaction.createdAt,
  }

  emitToReseller(effectiveResellerId, WS_EVENTS.TRANSACTION_NEW, payload)
  emitToAdmins(WS_EVENTS.PLATFORM_TRANSACTION_NEW, payload)

  if (merchant) {
    await dispatchMerchantWebhook(merchant, transaction, normalizedOrderId || transaction.orderId || '')
  }

  console.log(
    `[Gateway Failure] Marked FAILED: ${transaction.transactionId} (${transaction.merchantRefId}) | Reason: ${resolvedCode} — ${resolvedReason}`,
  )

  return {
    updated: true,
    created: !existingTxn,
    transactionId: transaction.transactionId,
  }
}

export async function reconcilePendingTransactions(olderThanMinutes = 15): Promise<{
  checked: number
  markedFailed: number
}> {
  const cutoff = new Date(Date.now() - Math.max(0, olderThanMinutes) * 60 * 1000)
  const pendingTxns = await Transaction.find({
    status: 'pending',
    createdAt: { $lte: cutoff },
    stripeSessionId: { $exists: true, $ne: '' },
  })
    .sort({ createdAt: -1 })
    .limit(50)

  let checked = 0
  let markedFailed = 0
  const maxSessionAgeMs = 24 * 60 * 60 * 1000

  for (const txn of pendingTxns) {
    checked++
    const bridgeKey = txn.bridgeProfile === 'leads' ? 'leads' : 'marketplace'
    const bridgeCfg = config.bridges?.[bridgeKey] || config.ecomBridge
    const bridgeUrl = bridgeCfg?.url?.replace(/\/+$/, '')
    const bridgeSecret = bridgeCfg?.secret?.trim()

    if (!bridgeUrl || !bridgeSecret || !txn.stripeSessionId) continue

    try {
      const baseBridgeUrl = bridgeUrl.endsWith('/initiate') ? bridgeUrl.replace(/\/initiate$/, '') : bridgeUrl
      const resp = await fetch(`${baseBridgeUrl}/session-status/${encodeURIComponent(txn.stripeSessionId)}`, {
        method: 'GET',
        headers: {
          'x-gateway-bridge-secret': bridgeSecret,
        },
        signal: AbortSignal.timeout(10000),
      })

      if (!resp.ok) continue

      const data = (await resp.json()) as {
        sessionStatus?: string
        paymentStatus?: string
        paymentIntentId?: string
        paymentIntentStatus?: string
        hasPaymentError?: boolean
        failureReason?: string
        declineCode?: string
      }

      const ageMs = Date.now() - new Date(txn.createdAt).getTime()
      const isExpired = data.sessionStatus === 'expired' || (data.sessionStatus === 'open' && ageMs > maxSessionAgeMs)
      const isFailed = Boolean(data.hasPaymentError) || data.paymentIntentStatus === 'canceled'

      if (isExpired || isFailed) {
        const result = await markTransactionFailed({
          stripeSessionId: txn.stripeSessionId,
          stripePaymentIntentId: data.paymentIntentId,
          merchantRefId: txn.merchantRefId,
          resellerId: String(txn.resellerId || 'admin_root'),
          orderId: txn.orderId,
          grossAmount: txn.grossAmount,
          currency: txn.currency,
          bridgeProfile: bridgeKey,
          failureReason:
            data.failureReason ||
            (isExpired ? 'Checkout session expired without payment' : 'Payment declined or blocked in Stripe'),
          declineCode: data.declineCode || (isExpired ? 'checkout.session.expired' : 'payment_failed'),
        })
        if (result.updated) markedFailed++
      }
    } catch (err: any) {
      console.warn(`[Reconcile Pending] Failed to check session ${txn.stripeSessionId}: ${err.message}`)
    }
  }

  return { checked, markedFailed }
}

export async function handleReconcilePendingTransactions(req: Request, res: Response): Promise<void> {
  const olderThanMinutes = Number(req.body?.olderThanMinutes ?? req.query?.olderThanMinutes ?? 5)
  const result = await reconcilePendingTransactions(isNaN(olderThanMinutes) ? 5 : olderThanMinutes)
  res.status(200).json({ success: true, ...result })
}
