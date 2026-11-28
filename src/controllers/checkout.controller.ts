import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { config } from '../config/env.js'
import { Merchant, type IMerchant } from '../models/Merchant.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Transaction } from '../models/Transaction.js'
import { VALID_BRIDGE_PROFILES, type BridgeProfile } from '../models/SystemConfig.js'
import { createOnePayPayment } from '../services/onepay.service.js'

export interface BridgeCheckoutParams {
  amount: number
  currency?: string
  orderId?: string
  customerEmail?: string
  productName?: string
  successUrl: string
  cancelUrl: string
  requestedMode?: string
  extraMetadata?: Record<string, unknown>
}

export type BridgeCheckoutResult =
  | {
      ok: true
      data: {
        success: true
        paymentRef: string
        sessionId: string
        checkoutUrl: string
        mode: 'test' | 'live'
      }
    }
  | {
      ok: false
      status: number
      body: {
        success: false
        code?: string
        message: string
      }
    }

/**
 * Validates merchant trial/live guardrails, routes checkout through the
 * assigned e-commerce bridge, and records a pending Transaction.
 */
export async function executeBridgeCheckoutForMerchant(
  merchant: IMerchant,
  params: BridgeCheckoutParams
): Promise<BridgeCheckoutResult> {
  const numericAmount = Number(params.amount)
  if (isNaN(numericAmount) || numericAmount < 0.5) {
    return {
      ok: false,
      status: 400,
      body: { success: false, message: 'Amount must be a valid number of at least $0.50.' },
    }
  }

  // Check 24-Hour Trial & Account Status Guardrails
  if (merchant.accountMode !== 'live') {
    if (merchant.accountMode === 'suspended') {
      return {
        ok: false,
        status: 403,
        body: {
          success: false,
          code: 'ACCOUNT_SUSPENDED',
          message: 'This merchant account is suspended. Please contact underwriting support.',
        },
      }
    }

    if (merchant.accountMode === 'trial') {
      if (!merchant.trial?.isActive || merchant.trial?.status !== 'active' || !merchant.trial?.expiresAt) {
        return {
          ok: false,
          status: 403,
          body: {
            success: false,
            code: 'TRIAL_NOT_ACTIVATED',
            message:
              '24-Hour Integration Trial has not been activated yet by underwriting. Please await approval before initiating transactions.',
          },
        }
      }

      const isExpired = new Date() > new Date(merchant.trial.expiresAt)
      if (isExpired) {
        merchant.trial.status = 'expired'
        merchant.trial.isActive = false
        await merchant.save()
        return {
          ok: false,
          status: 403,
          body: {
            success: false,
            code: 'TRIAL_EXPIRED',
            message:
              'Your 24-hour PGX integration trial has expired. Integration access and checkout sessions are disabled.',
          },
        }
      }

      const maxAllowed = merchant.trial?.maxTestAmount || 100
      if (numericAmount > maxAllowed) {
        return {
          ok: false,
          status: 400,
          body: {
            success: false,
            code: 'TRIAL_LIMIT_EXCEEDED',
            message: `Trial sandbox mode is limited to orders up to $${maxAllowed}.00. Settle your setup fee to activate unlimited volume.`,
          },
        }
      }
    } else {
      return {
        ok: false,
        status: 403,
        body: {
          success: false,
          code: 'ACCOUNT_NOT_LIVE',
          message: 'Merchant account is not active for live or trial processing.',
        },
      }
    }
  }

  const resellerId = merchant.resellerId || 'admin_root'
  const currency = (params.currency || 'USD').toUpperCase()

  let assignedBridgeKey: BridgeProfile =
    merchant.assignedBridge && VALID_BRIDGE_PROFILES.includes(merchant.assignedBridge)
      ? merchant.assignedBridge
      : 'marketplace'
  if (!merchant.assignedBridge) {
    const resellerConfig = await ResellerConfig.findOne({ resellerId })
    if (resellerConfig?.defaultBridge && VALID_BRIDGE_PROFILES.includes(resellerConfig.defaultBridge)) {
      assignedBridgeKey = resellerConfig.defaultBridge
    }
  }

  const effectiveMode: 'test' | 'live' =
    params.requestedMode === 'test' || params.requestedMode === 'sandbox'
      ? 'test'
      : merchant.accountMode === 'trial'
        ? 'test'
        : 'live'

  const rawOrderId = String(params.orderId || '').trim()
  const digitsOnly = rawOrderId.replace(/\D/g, '')
  let cleanOrderNum = ''
  if (digitsOnly.length >= 4) {
    cleanOrderNum = digitsOnly.slice(-4)
  } else if (digitsOnly.length > 0) {
    cleanOrderNum = digitsOnly.padStart(4, '0')
  } else {
    cleanOrderNum = Date.now().toString().slice(-4)
  }
  const cleanProductName = `Order #${cleanOrderNum}`
  const paymentRef = `pgx_${cleanOrderNum || Date.now().toString(36)}`

  let checkoutUrl = ''
  let rawSessionId = ''
  let extraTxnMeta: Record<string, unknown> = {}

  if (assignedBridgeKey === '1pay') {
    try {
      console.log(
        `[Checkout] Routing payment through 1pay.cx Card-to-Crypto (${effectiveMode}) for merchant ${merchant.refId}`
      )
      const onePayResult = await createOnePayPayment({
        amount: numericAmount,
        currency,
        email: params.customerEmail,
        productName: cleanProductName,
        reference: paymentRef,
        redirectUrl: params.successUrl,
        cancelUrl: params.cancelUrl,
        mode: effectiveMode,
        idempotencyKey: `${merchant.refId || merchant._id}_${rawOrderId || paymentRef}_${effectiveMode}`,
      })
      checkoutUrl = onePayResult.checkoutUrl
      rawSessionId = onePayResult.id
      extraTxnMeta = { processor: '1pay', onePayPaymentId: onePayResult.id, onePayMode: effectiveMode }
    } catch (onePayErr: any) {
      console.error(`[Checkout] Failed to initiate 1pay.cx payment: ${onePayErr.message}`)
      return {
        ok: false,
        status: 502,
        body: {
          success: false,
          message: `Card-to-Crypto processor error: ${onePayErr.message}`,
        },
      }
    }
  } else {
    const activeBridge = config.bridges?.[assignedBridgeKey] || {
      id: assignedBridgeKey,
      name: assignedBridgeKey === 'leads' ? 'PGX Leads' : 'PGX MarketPlace',
      domain: assignedBridgeKey === 'leads' ? 'pgxleads.shop' : 'pgxmarketplace.shop',
      url: config.ecomBridge.url,
      secret: config.ecomBridge.secret,
      enabled: config.ecomBridge.enabled,
    }

    if (!activeBridge.enabled || !activeBridge.url) {
      return {
        ok: false,
        status: 503,
        body: {
          success: false,
          message: 'E-Commerce payment gateway bridge is currently offline or disabled. Please contact administration.',
        },
      }
    }

    try {
      const bridgeEndpoint = `${activeBridge.url.replace(/\/+$/, '')}/api/gateway-bridge/initiate`
      console.log(
        `[Checkout] Routing payment through ${activeBridge.name} [${activeBridge.domain}]: ${bridgeEndpoint} for merchant ${merchant.refId}`
      )

      const bridgeRes = await fetch(bridgeEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gateway-bridge-secret': activeBridge.secret,
        },
        body: JSON.stringify({
          merchantRefId: merchant.refId,
          resellerId,
          orderId: `ORD-${cleanOrderNum}`,
          amount: numericAmount,
          currency,
          customerEmail: params.customerEmail,
          productName: cleanProductName,
          successUrl: params.successUrl,
          cancelUrl: params.cancelUrl,
          mode: effectiveMode,
        }),
      })

      if (!bridgeRes.ok) {
        const errText = await bridgeRes.text()
        console.warn(`[Checkout] E-Commerce Bridge error: ${bridgeRes.status} ${errText}`)
        return {
          ok: false,
          status: bridgeRes.status,
          body: {
            success: false,
            message: `E-Commerce payment bridge error: ${errText || bridgeRes.statusText}`,
          },
        }
      }

      const bridgeData = (await bridgeRes.json()) as any
      checkoutUrl = bridgeData.checkoutUrl || bridgeData.data?.checkoutUrl
      rawSessionId = bridgeData.sessionId || bridgeData.data?.sessionId
    } catch (bridgeErr: any) {
      console.error(`[Checkout] Failed to reach E-Commerce Bridge: ${bridgeErr.message}`)
      return {
        ok: false,
        status: 502,
        body: {
          success: false,
          message: `Failed to connect to E-Commerce payment bridge: ${bridgeErr.message}`,
        },
      }
    }
  }

  try {
    const pendingTxnId = `TXN_PEND_${Date.now().toString().slice(-4)}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    await Transaction.create({
      transactionId: pendingTxnId,
      resellerId,
      merchantId: merchant._id,
      merchantRefId: merchant.refId,
      bridgeProfile: assignedBridgeKey,
      stripeSessionId: rawSessionId,
      paymentRef,
      orderId: `ORD-${cleanOrderNum}`,
      currency,
      grossAmount: numericAmount,
      grossCents: Math.round(numericAmount * 100),
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
      status: 'pending',
      customerEmail: params.customerEmail,
      productName: params.productName,
      metadata: {
        rawOrderId,
        cleanOrderNum,
        paymentRef,
        checkoutUrl,
        ...extraTxnMeta,
        ...(params.extraMetadata || {}),
      },
    })
  } catch (pendingErr: any) {
    console.warn(`[Checkout] Non-blocking pending transaction save notice: ${pendingErr.message}`)
  }

  return {
    ok: true,
    data: {
      success: true,
      paymentRef,
      sessionId: paymentRef,
      checkoutUrl,
      mode: effectiveMode,
    },
  }
}

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

    const clientOrigin = req.headers.origin || 'http://localhost:5173'
    const resolvedSuccessUrl =
      successUrl || `${clientOrigin}/checkout?ref=${merchant.refId}&status=success&session_id={CHECKOUT_SESSION_ID}`
    const resolvedCancelUrl =
      cancelUrl || `${clientOrigin}/checkout?ref=${merchant.refId}&status=cancelled`

    const result = await executeBridgeCheckoutForMerchant(merchant, {
      amount: numericAmount,
      currency,
      orderId,
      customerEmail,
      productName,
      successUrl: resolvedSuccessUrl,
      cancelUrl: resolvedCancelUrl,
      requestedMode,
    })

    if (!result.ok) {
      return res.status(result.status).json(result.body)
    }

    return res.status(200).json(result.data)
  } catch (error) {
    next(error)
  }
}

export async function getCheckoutSessionStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const rawId = String(req.params.sessionId || '').trim()

    if (!rawId) {
      return res.status(400).json({ success: false, message: 'Session ID or Reference is required.' })
    }

    const digitsOnly = rawId.replace(/\D/g, '')
    const cleanNum = digitsOnly.length >= 4 ? digitsOnly.slice(-4) : digitsOnly

    const queryConditions: any[] = [
      { paymentRef: rawId },
      { stripeSessionId: rawId },
      { transactionId: rawId },
      { orderId: rawId },
      { 'metadata.paymentRef': rawId },
      { 'metadata.rawOrderId': rawId },
    ]

    if (cleanNum) {
      queryConditions.push(
        { paymentRef: `pgx_${cleanNum}` },
        { orderId: `ORD-${cleanNum}` },
        { orderId: cleanNum },
        { transactionId: new RegExp(`_${cleanNum}_`, 'i') }
      )
    }

    const txn = await Transaction.findOne({ $or: queryConditions })

    if (!txn) {
      return res.status(200).json({
        success: true,
        status: 'pending',
        message: 'Payment is processing or awaiting confirmation.',
      })
    }

    const isCompleted = txn.status === 'succeeded' || (txn.status as string) === 'completed'
    const statusString = isCompleted ? 'completed' : txn.status
    const resolvedRef = txn.paymentRef || (txn.orderId ? `pgx_${String(txn.orderId).replace(/\D/g, '').slice(-4)}` : `pgx_${cleanNum || '0000'}`)

    return res.status(200).json({
      success: true,
      status: statusString,
      paymentRef: resolvedRef,
      sessionId: resolvedRef,
      transactionId: txn.transactionId,
      orderId: txn.orderId,
      grossAmount: txn.grossAmount,
      currency: txn.currency,
      merchantRefId: txn.merchantRefId,
      merchantId: String(txn.merchantId),
      transaction: {
        transactionId: txn.transactionId,
        paymentRef: resolvedRef,
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
