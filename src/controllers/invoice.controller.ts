import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { Invoice, IInvoice, InvoiceStatus } from '../models/Invoice.js'
import { Merchant } from '../models/Merchant.js'
import { SystemConfig } from '../models/SystemConfig.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Transaction } from '../models/Transaction.js'
import { Notification } from '../models/Notification.js'
import { createStripeCheckoutSession } from '../services/stripe.service.js'
import { emitToAdmins, emitToMerchant, WS_EVENTS } from '../services/socket.service.js'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { AdminRequest } from '../middleware/admin.middleware.js'

// ----------------------------------------------------
// 1. MERCHANT: View Weekly Invoices
// ----------------------------------------------------
export async function getMerchantInvoices(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const invoices = await Invoice.find({ merchantId }).sort({ createdAt: -1 }).lean()

    // Calculate summary statistics
    const totalInvoiced = invoices.reduce((acc, inv) => acc + inv.payableAmount, 0)
    const totalPaid = invoices.filter((inv) => inv.status === 'paid').reduce((acc, inv) => acc + inv.payableAmount, 0)
    const totalOutstanding = invoices
      .filter((inv) => ['issued', 'pending', 'under_review', 'overdue'].includes(inv.status))
      .reduce((acc, inv) => acc + inv.payableAmount, 0)

    return res.status(200).json({
      success: true,
      summary: {
        totalInvoiced,
        totalPaid,
        totalOutstanding,
        invoiceCount: invoices.length,
      },
      invoices,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 2. MERCHANT: Pay Invoice via Stripe Checkout
// ----------------------------------------------------
export async function payInvoiceViaStripe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const invoiceId = String(req.params.invoiceId)

    const invoice = await Invoice.findOne({ _id: invoiceId, merchantId })
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' })
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ success: false, message: 'This invoice has already been paid.' })
    }

    const config = await SystemConfig.findOne()
    if (!config?.stripe?.secretKey || !config?.stripe?.isConfigured) {
      return res.status(400).json({
        success: false,
        message: 'Platform Stripe gateway is not configured by Super Admin.',
      })
    }

    const appOrigin = req.headers.origin || 'http://localhost:5173'
    const successUrl = `${appOrigin}/dashboard?tab=invoices&invoice_paid=success&invoice=${invoice.invoiceNumber}`
    const cancelUrl = `${appOrigin}/dashboard?tab=invoices&invoice_paid=cancelled`

    const session = await createStripeCheckoutSession({
      secretKey: config.stripe.secretKey,
      amount: invoice.payableAmount,
      currency: 'usd',
      productName: `PGX Gateway Weekly Service Fee (${invoice.invoiceNumber})`,
      merchantRefId: String(merchantId),
      resellerId: invoice.resellerId || 'admin_root',
      customerEmail: invoice.merchantEmail,
      orderId: invoice.invoiceNumber,
      successUrl,
      cancelUrl,
      metadata: {
        type: 'weekly_invoice',
        invoiceId: invoice._id.toString(),
        invoiceNumber: invoice.invoiceNumber,
        merchantId: merchantId.toString(),
      },
    })

    invoice.stripeSessionId = session.id
    invoice.paymentMethod = 'stripe'
    invoice.status = 'pending'
    await invoice.save()

    return res.status(200).json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.payableAmount,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 3. MERCHANT: Upload Bank Transfer Proof
// ----------------------------------------------------
export async function uploadInvoiceProof(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const invoiceId = String(req.params.invoiceId)
    const { proofDocUrl, notes } = req.body

    const invoice = await Invoice.findOne({ _id: invoiceId, merchantId })
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' })
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ success: false, message: 'This invoice has already been paid.' })
    }

    invoice.status = 'under_review'
    invoice.paymentMethod = 'bank_transfer'
    if (proofDocUrl) invoice.proofDocUrl = proofDocUrl
    if (notes) invoice.adminNotes = `Merchant Note: ${notes}`
    await invoice.save()

    // Notify Super Admin
    await Notification.create({
      merchantId,
      title: 'Invoice Payment Proof Uploaded',
      content: `Merchant ${invoice.merchantName} uploaded wire payment proof for ${invoice.invoiceNumber} ($${invoice.payableAmount}).`,
      type: 'system',
    })

    emitToAdmins(WS_EVENTS.DOCUMENT_UPLOADED, {
      type: 'invoice_proof',
      invoiceNumber: invoice.invoiceNumber,
      merchantId,
      amount: invoice.payableAmount,
    })

    return res.status(200).json({
      success: true,
      message: 'Payment proof submitted successfully. Super Admin is reviewing the settlement.',
      invoice,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 4. SUPER ADMIN: List All Weekly Invoices
// ----------------------------------------------------
export async function getAdminInvoices(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { status, search } = req.query

    const filter: any = {}
    if (status && status !== 'all') {
      filter.status = status
    }

    if (search && typeof search === 'string') {
      filter.$or = [
        { invoiceNumber: { $regex: search, $options: 'i' } },
        { merchantName: { $regex: search, $options: 'i' } },
        { merchantEmail: { $regex: search, $options: 'i' } },
      ]
    }

    const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).lean()

    const summary = {
      totalInvoiced: invoices.reduce((acc, i) => acc + i.payableAmount, 0),
      totalPaid: invoices.filter((i) => i.status === 'paid').reduce((acc, i) => acc + i.payableAmount, 0),
      totalUnderReview: invoices.filter((i) => i.status === 'under_review').reduce((acc, i) => acc + i.payableAmount, 0),
      totalOverdue: invoices.filter((i) => i.status === 'overdue').reduce((acc, i) => acc + i.payableAmount, 0),
      count: invoices.length,
    }

    return res.status(200).json({
      success: true,
      summary,
      invoices,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 5. SUPER ADMIN: Auto-Generate Weekly Statement
// ----------------------------------------------------
export async function generateWeeklyInvoice(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { merchantId, eligibleVolume, billingCycleStart, billingCycleEnd } = req.body

    if (!merchantId) {
      return res.status(400).json({ success: false, message: 'merchantId is required' })
    }

    const merchant = await Merchant.findById(merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' })
    }

    const volume = Math.max(0, Number(eligibleVolume || 0))
    const feeRate = 9.0 // PRD Section 07 standard 9% ongoing service fee
    const payableAmount = Math.round(volume * (feeRate / 100) * 100) / 100

    const resellerShareRate = 2.0 // PRD Section 07 illustrative 2% reseller share
    const resellerShareAmount = Math.round(volume * (resellerShareRate / 100) * 100) / 100
    const platformRetainedAmount = Math.max(0, payableAmount - resellerShareAmount)

    const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase()
    const invoiceNumber = `INV-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}${randomSuffix}`

    const startDate = billingCycleStart ? new Date(billingCycleStart) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const endDate = billingCycleEnd ? new Date(billingCycleEnd) : new Date()
    const dueDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) // 5 business days per PRD

    const invoice = await Invoice.create({
      invoiceNumber,
      merchantId: merchant._id,
      merchantName: merchant.fullName,
      merchantEmail: merchant.businessEmail,
      resellerId: merchant.resellerId || 'admin_root',
      billingCycleStart: startDate,
      billingCycleEnd: endDate,
      eligibleVolume: volume,
      feeRate,
      payableAmount,
      resellerShareRate,
      resellerShareAmount,
      platformRetainedAmount,
      status: 'issued',
      dueDate,
    })

    // Notify Merchant
    await Notification.create({
      merchantId: merchant._id,
      title: `Weekly Invoice Generated (${invoiceNumber})`,
      content: `Your weekly PGX Gateway 9% service invoice for $${payableAmount.toFixed(2)} USD has been issued. Due in 5 days.`,
      type: 'system',
    })

    emitToMerchant(String(merchant._id), 'invoice_issued', invoice)

    return res.status(201).json({
      success: true,
      message: `Weekly invoice ${invoiceNumber} issued successfully.`,
      invoice,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 6. SUPER ADMIN: Reconcile / Mark Settled / Adjust
// ----------------------------------------------------
export async function updateAdminInvoiceStatus(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { invoiceId } = req.params
    const { status, adminNotes } = req.body

    const invoice = await Invoice.findById(invoiceId)
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' })
    }

    const previousStatus = invoice.status
    if (status) invoice.status = status as InvoiceStatus
    if (adminNotes !== undefined) invoice.adminNotes = adminNotes

    if (status === 'paid' && previousStatus !== 'paid') {
      invoice.paidAt = new Date()

      // Credit reseller affiliate commission if not yet credited
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
    }

    await invoice.save()

    // Notify Merchant
    await Notification.create({
      merchantId: invoice.merchantId,
      title: `Invoice ${invoice.invoiceNumber} Update`,
      content: `Your invoice status has been updated to: ${invoice.status.toUpperCase()}`,
      type: 'system',
    })

    emitToMerchant(String(invoice.merchantId), 'invoice_status_updated', {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
    })

    return res.status(200).json({
      success: true,
      message: `Invoice ${invoice.invoiceNumber} updated to ${invoice.status}.`,
      invoice,
    })
  } catch (error) {
    next(error)
  }
}
