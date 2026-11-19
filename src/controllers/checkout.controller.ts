import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { config } from '../config/env.js'
import { Merchant } from '../models/Merchant.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Transaction } from '../models/Transaction.js'
import { createStripeCheckoutSession } from '../services/stripe.service.js'

export async function getMerchantPublicProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const cleanRef = String(req.params.refId || '').trim()

    if (!cleanRef) {
      return res.status(400).json({ success: false, message: 'Merchant Reference ID is required.' })
    }

    const isObjectId = mongoose.Types.ObjectId.isValid(cleanRef) && cleanRef.length === 24
    const merchant = await Merchant.findOne(
      isObjectId
        ? { $or: [{ refId: cleanRef.toUpperCase() }, { _id: cleanRef }] }
        : { refId: cleanRef.toUpperCase() }
    ).select(
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
      webhookUrl,
      mode: requestedMode,
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

    // 1. Find Sub-Merchant (support both refId and _id in case merchant passes account ID)
    const cleanRef = String(refId || '').trim()
    const isObjectId = mongoose.Types.ObjectId.isValid(cleanRef) && cleanRef.length === 24
    const merchant = await Merchant.findOne(
      isObjectId
        ? { $or: [{ refId: cleanRef.toUpperCase() }, { _id: cleanRef }] }
        : { refId: cleanRef.toUpperCase() }
    )
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: `No active merchant found for reference ID ${refId}.`,
      })
    }

    // Save merchant webhook URL if passed from WooCommerce integration
    if (webhookUrl && typeof webhookUrl === 'string' && webhookUrl.startsWith('http')) {
      const trimmedUrl = webhookUrl.trim()
      const updatePayload: any = { webhookUrl: trimmedUrl }
      if (!merchant.webhookSecret) {
        updatePayload.webhookSecret = crypto.randomBytes(24).toString('hex')
      }
      await Merchant.findByIdAndUpdate(merchant._id, { $set: updatePayload })
      merchant.webhookUrl = trimmedUrl
      if (updatePayload.webhookSecret) {
        merchant.webhookSecret = updatePayload.webhookSecret
      }
    }

    // 2. Check 24-Hour Trial & Account Status Guardrails
    if (merchant.accountMode !== 'live') {
      if (merchant.accountMode === 'suspended') {
        return res.status(403).json({
          success: false,
          code: 'ACCOUNT_SUSPENDED',
          message: 'This merchant account is suspended. Please contact underwriting support.',
        })
      }

      if (merchant.accountMode === 'trial') {
        // Guardrail: Underwriting must explicitly turn on 24h trial
        if (!merchant.trial?.isActive || merchant.trial?.status !== 'active' || !merchant.trial?.expiresAt) {
          return res.status(403).json({
            success: false,
            code: 'TRIAL_NOT_ACTIVATED',
            message:
              '24-Hour Integration Trial has not been activated yet by underwriting. Please await approval before initiating transactions.',
          })
        }

        // Guardrail: 24h trial auto-expiry check
        const isExpired = new Date() > new Date(merchant.trial.expiresAt)
        if (isExpired) {
          merchant.trial.status = 'expired'
          merchant.trial.isActive = false
          await merchant.save()
          return res.status(403).json({
            success: false,
            code: 'TRIAL_EXPIRED',
            message:
              'Your 24-hour PGX integration trial has expired. Integration access and checkout sessions are disabled.',
          })
        }

        // Safety Guardrail: Max single trial transaction
        const maxAllowed = merchant.trial?.maxTestAmount || 100
        if (numericAmount > maxAllowed) {
          return res.status(400).json({
            success: false,
            code: 'TRIAL_LIMIT_EXCEEDED',
            message: `Trial sandbox mode is limited to orders up to $${maxAllowed}.00. Settle your setup fee to activate unlimited volume.`,
          })
        }
      } else {
        return res.status(403).json({
          success: false,
          code: 'ACCOUNT_NOT_LIVE',
          message: 'Merchant account is not active for live or trial processing.',
        })
      }
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

        const rawOrderId = String(orderId || '').trim()
        const digitsOnly = rawOrderId.replace(/\D/g, '')
        const cleanOrderNum = digitsOnly.length >= 2
          ? digitsOnly
          : (rawOrderId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || Date.now().toString().slice(-6))
        const cleanProductName = `Order #${cleanOrderNum}`

        const bridgeRes = await fetch(bridgeEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-gateway-bridge-secret': config.ecomBridge.secret,
          },
          body: JSON.stringify({
            merchantRefId: merchant.refId,
            resellerId,
            orderId: orderId || `ORD-${cleanOrderNum}`,
            amount: numericAmount,
            currency: currency.toUpperCase(),
            customerEmail,
            productName: cleanProductName,
            successUrl: resolvedSuccessUrl,
            cancelUrl: resolvedCancelUrl,
            mode: (requestedMode === 'test' || requestedMode === 'sandbox')
              ? 'test'
              : (merchant.accountMode === 'trial' ? 'test' : 'live'),
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
          console.warn(`[Checkout] E-Commerce Bridge error: ${bridgeRes.status} ${errText}`)
          return res.status(bridgeRes.status).json({
            success: false,
            message: `E-Commerce payment bridge error: ${errText || bridgeRes.statusText}`,
          })
        }
      } catch (bridgeErr: any) {
        console.error(`[Checkout] Failed to reach E-Commerce Bridge: ${bridgeErr.message}`)
        return res.status(502).json({
          success: false,
          message: `Failed to connect to E-Commerce payment bridge: ${bridgeErr.message}`,
        })
      }
    }

    return res.status(503).json({
      success: false,
      message: 'E-Commerce payment gateway bridge is currently offline or disabled. Please contact administration.',
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

    const isCompleted = txn.status === 'succeeded' || (txn.status as string) === 'completed'
    const statusString = isCompleted ? 'completed' : txn.status

    return res.status(200).json({
      success: true,
      status: statusString,
      transactionId: txn.transactionId,
      orderId: txn.orderId,
      grossAmount: txn.grossAmount,
      currency: txn.currency,
      merchantRefId: txn.merchantRefId,
      merchantId: String(txn.merchantId),
      transaction: {
        transactionId: txn.transactionId,
        orderId: txn.orderId,
        grossAmount: txn.grossAmount,
        currency: txn.currency,
        status: statusString,
        merchantRefId: txn.merchantRefId,
        merchantId: String(txn.merchantId),
        createdAt: txn.createdAt,
      },
    })
  } catch (error) {
    next(error)
  }
}
