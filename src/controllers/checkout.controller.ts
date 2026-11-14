import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'
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

    const resellerId = merchant.resellerId || 'admin_root'
    const clientOrigin = req.headers.origin || 'http://localhost:5173'

    const resolvedSuccessUrl =
      successUrl || `${clientOrigin}/checkout?ref=${merchant.refId}&status=success&session_id={CHECKOUT_SESSION_ID}`
    const resolvedCancelUrl =
      cancelUrl || `${clientOrigin}/checkout?ref=${merchant.refId}&status=cancelled`

    // 2. Primary Route: E-Commerce Payment Bridge (pgxdigital.shop)
    if (config.ecomBridge?.enabled && config.ecomBridge?.url) {
      try {
        const bridgeEndpoint = `${config.ecomBridge.url.replace(/\/+$/, '')}/api/gateway-bridge/initiate`
        console.log(`[Checkout] Routing payment through E-Commerce Bridge: ${bridgeEndpoint} for merchant ${merchant.refId}`)

        const bridgeRes = await fetch(bridgeEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-gateway-bridge-secret': config.ecomBridge.secret,
          },
          body: JSON.stringify({
            merchantRefId: merchant.refId,
            resellerId,
            orderId: orderId || `ORD-${Date.now().toString().slice(-6)}`,
            amount: numericAmount,
            currency: currency.toUpperCase(),
            customerEmail,
            productName: productName || `${merchant.legalName || merchant.fullName} Digital License`,
            successUrl: resolvedSuccessUrl,
            cancelUrl: resolvedCancelUrl,
          }),
        })

        if (bridgeRes.ok) {
          const bridgeData = (await bridgeRes.json()) as any
          const sessionId = bridgeData.sessionId || bridgeData.data?.sessionId
          const checkoutUrl = bridgeData.checkoutUrl || bridgeData.data?.checkoutUrl
          return res.status(200).json({
            success: true,
            sessionId,
            checkoutUrl,
            mode: 'ecom_bridge',
          })
        } else {
          const errText = await bridgeRes.text()
          console.warn(`[Checkout] E-Commerce Bridge returned error: ${bridgeRes.status} ${errText}. Attempting local fallback if configured...`)
        }
      } catch (bridgeErr: any) {
        console.error(`[Checkout] Failed to reach E-Commerce Bridge: ${bridgeErr.message}. Attempting local fallback...`)
      }
    }

    // 3. Fallback: Local Reseller Stripe Configuration
    let resellerConfig = await ResellerConfig.findOne({ resellerId })

    if (!resellerConfig || !resellerConfig.stripe?.secretKey) {
      resellerConfig = await ResellerConfig.findOne({ resellerId: 'admin_root' })
    }

    if (!resellerConfig || !resellerConfig.stripe?.secretKey) {
      return res.status(503).json({
        success: false,
        message: 'Gateway payment processor is currently unavailable. Please verify E-Commerce Bridge or Stripe credentials.',
      })
    }

    // 4. Initiate Direct Stripe Session
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
