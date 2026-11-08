import { Request, Response, NextFunction } from 'express'
import { Merchant } from '../models/Merchant.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Transaction } from '../models/Transaction.js'
import { createStripeCheckoutSession } from '../services/stripe.service.js'

export async function getMerchantPublicProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const refId = String(req.params.refId || '')

    if (!refId) {
      return res.status(400).json({ success: false, message: 'Merchant Reference ID is required.' })
    }

    const merchant = await Merchant.findOne({ refId: refId.toUpperCase().trim() }).select(
      'refId legalName fullName industry website applicationStatus avatarUrl'
    )

    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found for this Reference ID.' })
    }

    return res.status(200).json({
      success: true,
      merchant: {
        refId: merchant.refId,
        businessName: merchant.legalName || merchant.fullName,
        industry: merchant.industry,
        website: merchant.website,
        isVerified: merchant.applicationStatus === 'approved',
        avatarUrl: merchant.avatarUrl,
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function initiateCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      refId,
      amount,
      currency = 'USD',
      orderId,
      customerEmail,
      productName,
      successUrl,
      cancelUrl,
    } = req.body

    if (!refId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'refId and amount are required to initiate checkout.',
      })
    }

    const numericAmount = parseFloat(amount)
    if (isNaN(numericAmount) || numericAmount < 0.5) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a valid number of at least $0.50.',
      })
    }

    // 1. Find Sub-Merchant
    const merchant = await Merchant.findOne({ refId: refId.toUpperCase().trim() })
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: `No active merchant found for reference ID ${refId}.`,
      })
    }

    // 2. Find Reseller Stripe Configuration
    const resellerId = merchant.resellerId || 'admin_root'
    let resellerConfig = await ResellerConfig.findOne({ resellerId })

    if (!resellerConfig || !resellerConfig.stripe?.secretKey) {
      // Fallback check on admin_root
      resellerConfig = await ResellerConfig.findOne({ resellerId: 'admin_root' })
    }

    if (!resellerConfig || !resellerConfig.stripe?.secretKey) {
      return res.status(503).json({
        success: false,
        message: 'Gateway is currently in setup mode. Stripe credentials have not yet been configured by the admin.',
      })
    }

    const clientOrigin = req.headers.origin || 'http://localhost:5173'

    const resolvedSuccessUrl =
      successUrl || `${clientOrigin}/checkout?ref=${merchant.refId}&status=success&session_id={CHECKOUT_SESSION_ID}`
    const resolvedCancelUrl =
      cancelUrl || `${clientOrigin}/checkout?ref=${merchant.refId}&status=cancelled`

    // 3. Initiate Stripe Session with Reseller's Account & Merchant Ref ID metadata
    const session = await createStripeCheckoutSession({
      secretKey: resellerConfig.stripe.secretKey,
      amount: numericAmount,
      currency,
      productName: productName || `${merchant.legalName || merchant.fullName} Order`,
      merchantRefId: merchant.refId!,
      resellerId,
      orderId,
      customerEmail,
      successUrl: resolvedSuccessUrl,
      cancelUrl: resolvedCancelUrl,
    })

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url,
      publishableKey: resellerConfig.stripe.publishableKey,
    })
  } catch (error) {
    next(error)
  }
}

export async function getCheckoutSessionStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionId = String(req.params.sessionId || '')

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'Session ID is required.' })
    }

    const txn = await Transaction.findOne({ stripeSessionId: sessionId })

    if (!txn) {
      return res.status(200).json({
        success: true,
        status: 'pending',
        message: 'Payment is processing or awaiting confirmation.',
      })
    }

    return res.status(200).json({
      success: true,
      transaction: {
        transactionId: txn.transactionId,
        grossAmount: txn.grossAmount,
        currency: txn.currency,
        status: txn.status,
        merchantRefId: txn.merchantRefId,
        createdAt: txn.createdAt,
      },
    })
  } catch (error) {
    next(error)
  }
}
