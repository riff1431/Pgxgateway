import { Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { Merchant } from '../models/Merchant.js'
import { PaymentLink } from '../models/PaymentLink.js'
import { executeBridgeCheckoutForMerchant } from './checkout.controller.js'

const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD'])

function generatePaymentLinkSlug(): string {
  return `pl_${crypto.randomBytes(4).toString('hex')}`
}

// ----------------------------------------------------
// MERCHANT: List Payment Links
// ----------------------------------------------------
export async function listMerchantPaymentLinks(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant!
    const links = await PaymentLink.find({ merchantId: merchant._id }).sort({ createdAt: -1 }).lean()

    return res.status(200).json({
      success: true,
      data: links,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// MERCHANT: Create Payment Link
// ----------------------------------------------------
export async function createPaymentLink(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant!
    const { title, description, amount, currency = 'USD', reusable = true } = req.body

    const cleanTitle = String(title || '').trim()
    if (!cleanTitle) {
      return res.status(400).json({ success: false, message: 'Payment link title is required.' })
    }

    const numericAmount = parseFloat(amount)
    if (isNaN(numericAmount) || numericAmount < 0.5) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a valid number of at least $0.50.',
      })
    }

    const normalizedCurrency = String(currency || 'USD').toUpperCase().trim()
    if (!SUPPORTED_CURRENCIES.has(normalizedCurrency)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported currency. Supported: ${Array.from(SUPPORTED_CURRENCIES).join(', ')}`,
      })
    }

    let slug = generatePaymentLinkSlug()
    while (await PaymentLink.exists({ slug })) {
      slug = generatePaymentLinkSlug()
    }

    const link = await PaymentLink.create({
      slug,
      merchantId: merchant._id,
      merchantRefId: merchant.refId || String(merchant._id),
      resellerId: merchant.resellerId || 'admin_root',
      title: cleanTitle,
      description: description ? String(description).trim().slice(0, 500) : undefined,
      amount: Math.round(numericAmount * 100) / 100,
      currency: normalizedCurrency,
      reusable: Boolean(reusable),
      status: 'active',
    })

    return res.status(201).json({
      success: true,
      message: 'Payment link created successfully.',
      data: link,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// MERCHANT: Toggle / Update Payment Link Status
// ----------------------------------------------------
export async function updatePaymentLinkStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant!
    const { id } = req.params
    const { status } = req.body

    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be "active" or "disabled".' })
    }

    const link = await PaymentLink.findOne({ _id: id, merchantId: merchant._id })
    if (!link) {
      return res.status(404).json({ success: false, message: 'Payment link not found.' })
    }

    if (link.status === 'completed' && !link.reusable && status === 'active') {
      return res.status(400).json({
        success: false,
        message: 'One-time payment link has already been paid and completed.',
      })
    }

    link.status = status
    await link.save()

    return res.status(200).json({
      success: true,
      message: `Payment link ${status === 'active' ? 'activated' : 'paused'}.`,
      data: link,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// MERCHANT: Delete Payment Link
// ----------------------------------------------------
export async function deletePaymentLink(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant!
    const { id } = req.params

    const deleted = await PaymentLink.findOneAndDelete({ _id: id, merchantId: merchant._id })
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Payment link not found.' })
    }

    return res.status(200).json({
      success: true,
      message: 'Payment link deleted.',
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// PUBLIC: Resolve Payment Link Metadata for Shopper Page
// ----------------------------------------------------
export async function getPublicPaymentLink(req: Request, res: Response, next: NextFunction) {
  try {
    const slug = String(req.params.slug || '').trim()
    if (!slug) {
      return res.status(400).json({ success: false, message: 'Payment link slug is required.' })
    }

    const link = await PaymentLink.findOne({ slug }).lean()
    if (!link) {
      return res.status(404).json({ success: false, message: 'Payment link not found or expired.' })
    }

    const merchant = await Merchant.findById(link.merchantId)
      .select('refId legalName fullName industry website applicationStatus avatarUrl')
      .lean()

    return res.status(200).json({
      success: true,
      paymentLink: {
        slug: link.slug,
        title: link.title,
        description: link.description,
        amount: link.amount,
        currency: link.currency,
        reusable: link.reusable,
        status: link.status,
      },
      merchant: merchant
        ? {
            refId: merchant.refId,
            businessName: merchant.legalName || merchant.fullName,
            industry: merchant.industry,
            website: merchant.website,
            isVerified: merchant.applicationStatus === 'approved',
            avatarUrl: merchant.avatarUrl,
          }
        : null,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// PUBLIC: Initiate Cloaked Checkout from a Payment Link
// ----------------------------------------------------
export async function initiatePaymentLinkCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const slug = String(req.params.slug || '').trim()
    const { customerEmail } = req.body || {}

    const link = await PaymentLink.findOne({ slug })
    if (!link) {
      return res.status(404).json({ success: false, message: 'Payment link not found.' })
    }

    if (link.status === 'disabled') {
      return res.status(400).json({ success: false, message: 'This payment link is currently paused by the merchant.' })
    }

    if (link.status === 'completed') {
      return res.status(400).json({ success: false, message: 'This one-time payment link has already been paid.' })
    }

    const merchant = await Merchant.findById(link.merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant account for this link was not found.' })
    }

    const clientOrigin = req.headers.origin || 'https://pgxgateway.com'
    const successUrl = `${clientOrigin}/pay/${encodeURIComponent(link.slug)}?status=success&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${clientOrigin}/pay/${encodeURIComponent(link.slug)}?status=cancelled`
    const orderId = `${link.slug.toUpperCase()}-${Date.now().toString().slice(-4)}`

    const result = await executeBridgeCheckoutForMerchant(merchant, {
      amount: link.amount,
      currency: link.currency,
      orderId,
      customerEmail: customerEmail ? String(customerEmail).trim() : undefined,
      productName: link.title,
      successUrl,
      cancelUrl,
      extraMetadata: {
        paymentLinkId: String(link._id),
        paymentLinkSlug: link.slug,
        realProductName: link.title,
      },
    })

    if (!result.ok) {
      return res.status(result.status).json(result.body)
    }

    return res.status(200).json(result.data)
  } catch (error) {
    next(error)
  }
}
