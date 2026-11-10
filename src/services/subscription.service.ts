import crypto from 'crypto'
import { Merchant, IMerchant } from '../models/Merchant.js'
import { Invoice } from '../models/Invoice.js'
import { Transaction } from '../models/Transaction.js'
import { Notification } from '../models/Notification.js'
import { SystemConfig } from '../models/SystemConfig.js'
import { chargeStripeOffSession } from './stripe.service.js'
import { emitToMerchant, emitToAdmins, WS_EVENTS } from './socket.service.js'

function generateMaintenanceInvoiceNumber(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase()
  return `INV-MAINT-${dateStr}-${randomHex}`
}

export function parseMonthlyFee(raw?: string): number {
  if (!raw) return 99.0
  const parsed = parseFloat(String(raw).replace(/[^0-9.]/g, ''))
  return isNaN(parsed) || parsed <= 0 ? 99.0 : parsed
}

export interface ChargeResult {
  merchantId: string
  merchantName: string
  channel: 'stripe_card' | 'crypto_manual'
  status: 'succeeded' | 'failed' | 'invoiced'
  amount: number
  surcharge: number
  invoiceNumber: string
  error?: string
}

/**
 * Execute monthly recurring charge for a single merchant.
 */
export async function executeMerchantMonthlyCharge(merchantId: string): Promise<ChargeResult> {
  const merchant = await Merchant.findById(merchantId)
  if (!merchant) {
    throw new Error(`Merchant ${merchantId} not found`)
  }

  const baseMonthlyFee = merchant.subscription?.monthlyFee || parseMonthlyFee(merchant.offer?.monthlyFee)
  const stripeCustomerId = merchant.subscription?.stripeCustomerId
  const invoiceNumber = generateMaintenanceInvoiceNumber()
  const billingCycleStart = merchant.subscription?.lastBilledDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const billingCycleEnd = new Date()

  // 1. Stripe Off-Session Card Auto-Debit Path
  if (stripeCustomerId) {
    const config = await SystemConfig.findOne()
    const stripeSecretKey = config?.stripe?.secretKey

    // 3% card fee surcharge
    const surcharge = Math.round(baseMonthlyFee * 0.03 * 100) / 100
    const totalAmount = Math.round((baseMonthlyFee + surcharge) * 100) / 100

    if (!stripeSecretKey || !config?.stripe?.isConfigured) {
      console.warn(`[Subscription Service] Cannot charge merchant ${merchant.fullName}: Stripe key not configured.`)
      return {
        merchantId: String(merchant._id),
        merchantName: merchant.fullName,
        channel: 'stripe_card',
        status: 'failed',
        amount: totalAmount,
        surcharge,
        invoiceNumber,
        error: 'Stripe gateway key not configured',
      }
    }

    try {
      // Execute off-session Stripe payment
      const paymentIntent = await chargeStripeOffSession({
        secretKey: stripeSecretKey,
        customerId: stripeCustomerId,
        amount: totalAmount,
        currency: 'usd',
        description: `PGX Monthly Maintenance Fee (${merchant.refId || merchant.fullName})`,
        merchantRefId: merchant.refId || String(merchant._id),
        resellerId: merchant.resellerId || 'admin_root',
        metadata: {
          invoice_number: invoiceNumber,
          type: 'monthly_maintenance',
          base_fee: String(baseMonthlyFee),
          surcharge: String(surcharge),
        },
      })

      // Charge Succeeded: Generate Paid Invoice
      await Invoice.create({
        invoiceNumber,
        merchantId: merchant._id,
        merchantName: merchant.fullName,
        merchantEmail: merchant.businessEmail,
        resellerId: merchant.resellerId || 'admin_root',
        billingCycleStart,
        billingCycleEnd,
        eligibleVolume: 0,
        feeRate: 0,
        payableAmount: totalAmount,
        surchargeAmount: surcharge,
        invoiceType: 'monthly_maintenance',
        status: 'paid',
        dueDate: new Date(),
        paidAt: new Date(),
        paymentMethod: 'stripe',
        stripeSessionId: paymentIntent.id,
        adminNotes: `Automated off-session Stripe debit succeeded ($${baseMonthlyFee} base + $${surcharge} 3% card fee). PaymentIntent: ${paymentIntent.id}`,
      })

      // Record in ledger Transactions
      const txnSuffix = crypto.randomBytes(3).toString('hex').toUpperCase()
      await Transaction.create({
        transactionId: `TXN_MAINT_${Date.now().toString().slice(-4)}_${txnSuffix}`,
        resellerId: merchant.resellerId || 'admin_root',
        merchantId: merchant._id,
        merchantRefId: merchant.refId || String(merchant._id),
        stripePaymentIntentId: paymentIntent.id,
        stripeEventId: `evt_maint_${Date.now()}`,
        currency: 'USD',
        grossAmount: totalAmount,
        platformFeeAmount: totalAmount,
        resellerSpreadAmount: 0,
        merchantNetAmount: 0,
        status: 'succeeded',
        customerEmail: merchant.businessEmail,
        orderId: `MAINT-${invoiceNumber.slice(-8)}`,
      })

      // Advance Next Billing Date by 30 days
      merchant.subscription = {
        ...(merchant.subscription || { autoRenew: true }),
        status: 'active',
        monthlyFee: baseMonthlyFee,
        nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        lastBilledDate: new Date(),
        stripeCustomerId,
        failureCount: 0,
        gracePeriodEnd: undefined,
        autoRenew: merchant.subscription?.autoRenew ?? true,
      }
      await merchant.save()

      // Notify Merchant
      await Notification.create({
        merchantId: merchant._id,
        title: 'Monthly Subscription Auto-Renewed',
        content: `Your monthly platform maintenance fee of $${totalAmount} ($${baseMonthlyFee} + $${surcharge} card fee) was successfully processed. Invoice #${invoiceNumber}.`,
        type: 'system',
      })

      emitToMerchant(String(merchant._id), 'subscription_renewed', {
        invoiceNumber,
        amount: totalAmount,
        nextBillingDate: merchant.subscription.nextBillingDate,
      })

      return {
        merchantId: String(merchant._id),
        merchantName: merchant.fullName,
        channel: 'stripe_card',
        status: 'succeeded',
        amount: totalAmount,
        surcharge,
        invoiceNumber,
      }
    } catch (chargeErr: any) {
      console.error(`[Subscription Service] Off-session charge failed for ${merchant.fullName}:`, chargeErr.message)

      // Grace period: 5 days
      const gracePeriodEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
      const currentFailures = (merchant.subscription?.failureCount || 0) + 1

      // Create Pending/Overdue Invoice for manual remediation
      await Invoice.create({
        invoiceNumber,
        merchantId: merchant._id,
        merchantName: merchant.fullName,
        merchantEmail: merchant.businessEmail,
        resellerId: merchant.resellerId || 'admin_root',
        billingCycleStart,
        billingCycleEnd,
        eligibleVolume: 0,
        feeRate: 0,
        payableAmount: totalAmount,
        surchargeAmount: surcharge,
        invoiceType: 'monthly_maintenance',
        status: 'overdue',
        dueDate: gracePeriodEnd,
        adminNotes: `Automated off-session Stripe debit failed: ${chargeErr.message}. 5-day grace window active until ${gracePeriodEnd.toISOString().slice(0, 10)}.`,
      })

      merchant.subscription = {
        ...(merchant.subscription || { autoRenew: true }),
        status: 'past_due',
        monthlyFee: baseMonthlyFee,
        failureCount: currentFailures,
        gracePeriodEnd,
        stripeCustomerId,
        autoRenew: merchant.subscription?.autoRenew ?? true,
      }
      await merchant.save()

      // High-priority alert to merchant
      await Notification.create({
        merchantId: merchant._id,
        title: 'Monthly Maintenance Charge Declined',
        content: `We could not auto-debit your monthly maintenance fee ($${totalAmount}). Please review Invoice #${invoiceNumber} or contact support. Grace period ends on ${gracePeriodEnd.toLocaleDateString()}.`,
        type: 'system',
      })

      emitToMerchant(String(merchant._id), 'subscription_past_due', {
        invoiceNumber,
        amount: totalAmount,
        gracePeriodEnd,
      })

      return {
        merchantId: String(merchant._id),
        merchantName: merchant.fullName,
        channel: 'stripe_card',
        status: 'failed',
        amount: totalAmount,
        surcharge,
        invoiceNumber,
        error: chargeErr.message,
      }
    }
  }

  // 2. Crypto Manual Invoice Path (0% Surcharge, $99.00 in BTC)
  const dueDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
  await Invoice.create({
    invoiceNumber,
    merchantId: merchant._id,
    merchantName: merchant.fullName,
    merchantEmail: merchant.businessEmail,
    resellerId: merchant.resellerId || 'admin_root',
    billingCycleStart,
    billingCycleEnd,
    eligibleVolume: 0,
    feeRate: 0,
    payableAmount: baseMonthlyFee,
    surchargeAmount: 0,
    invoiceType: 'monthly_maintenance',
    status: 'issued',
    dueDate,
    adminNotes: `Monthly platform maintenance fee ($${baseMonthlyFee} in BTC). Settle via WhatsApp finance desk (+1 437 577-8785) with 0% processing fee.`,
  })

  // Set subscription status
  merchant.subscription = {
    ...(merchant.subscription || { autoRenew: true }),
    status: 'active',
    monthlyFee: baseMonthlyFee,
    nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    autoRenew: merchant.subscription?.autoRenew ?? true,
  }
  await merchant.save()

  await Notification.create({
    merchantId: merchant._id,
    title: 'Monthly Platform Maintenance Invoice Issued',
    content: `Invoice #${invoiceNumber} for $${baseMonthlyFee} in BTC (0% fee) has been generated. Due date: ${dueDate.toLocaleDateString()}.`,
    type: 'system',
  })

  emitToMerchant(String(merchant._id), 'invoice_issued', {
    invoiceNumber,
    amount: baseMonthlyFee,
    dueDate,
  })

  return {
    merchantId: String(merchant._id),
    merchantName: merchant.fullName,
    channel: 'crypto_manual',
    status: 'invoiced',
    amount: baseMonthlyFee,
    surcharge: 0,
    invoiceNumber,
  }
}

/**
 * Scan all merchants whose billing cycle is due today and execute subscription cycle.
 */
export async function runDailySubscriptionCycle(): Promise<{
  timestamp: string
  totalEvaluated: number
  succeeded: number
  failed: number
  invoiced: number
  results: ChargeResult[]
}> {
  console.log('[Subscription Engine] Starting daily maintenance billing evaluation...')
  const now = new Date()

  // Find merchants that are active/past_due with autoRenew=true and nextBillingDate <= now
  const dueMerchants = await Merchant.find({
    setupStatus: { $in: ['paid_setup', 'collab_submitted', 'in_development', 'in_progress', 'integration_testing', 'delivered', 'completed'] },
    'subscription.status': { $in: ['active', 'past_due'] },
    'subscription.autoRenew': true,
    'subscription.nextBillingDate': { $lte: now },
  })

  console.log(`[Subscription Engine] Found ${dueMerchants.length} merchants due for monthly renewal.`)

  const results: ChargeResult[] = []
  let succeeded = 0
  let failed = 0
  let invoiced = 0

  for (const merchant of dueMerchants) {
    try {
      const res = await executeMerchantMonthlyCharge(String(merchant._id))
      results.push(res)
      if (res.status === 'succeeded') succeeded++
      else if (res.status === 'failed') failed++
      else if (res.status === 'invoiced') invoiced++
    } catch (err: any) {
      console.error(`[Subscription Engine] Unexpected error executing charge for merchant ${merchant._id}:`, err)
      failed++
      results.push({
        merchantId: String(merchant._id),
        merchantName: merchant.fullName,
        channel: merchant.subscription?.stripeCustomerId ? 'stripe_card' : 'crypto_manual',
        status: 'failed',
        amount: merchant.subscription?.monthlyFee || 99,
        surcharge: 0,
        invoiceNumber: 'ERROR',
        error: err.message,
      })
    }
  }

  console.log(`[Subscription Engine] Evaluation completed: ${succeeded} succeeded, ${invoiced} crypto invoiced, ${failed} failed.`)

  emitToAdmins(WS_EVENTS.PAYMENT_RECEIVED, {
    type: 'subscription_cycle_summary',
    totalEvaluated: dueMerchants.length,
    succeeded,
    invoiced,
    failed,
  })

  return {
    timestamp: now.toISOString(),
    totalEvaluated: dueMerchants.length,
    succeeded,
    failed,
    invoiced,
    results,
  }
}
