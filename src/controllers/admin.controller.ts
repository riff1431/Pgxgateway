import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'
import { signToken } from '../utils/jwt.js'
import { Merchant } from '../models/Merchant.js'
import { Notification } from '../models/Notification.js'
import { SystemConfig } from '../models/SystemConfig.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Transaction } from '../models/Transaction.js'
import { emitToMerchant, emitToAdmins, WS_EVENTS } from '../services/socket.service.js'
import { uploadBufferToCloudinary } from '../config/cloudinary.js'

// Admin Login
export async function adminLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide admin email and password.',
      })
    }

    const normalizedEmail = email.toLowerCase().trim()

    if (
      normalizedEmail !== config.admin.email.toLowerCase() ||
      password !== config.admin.password
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid administrative credentials.',
      })
    }

    const token = signToken({
      id: 'admin_root',
      email: normalizedEmail,
      role: 'admin',
    })

    res.status(200).json({
      success: true,
      message: 'Admin authenticated successfully.',
      token,
      admin: {
        email: normalizedEmail,
        role: 'admin',
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get Applications List with Filtering & Search
export async function getApplications(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, search, page = '1', limit = '20' } = req.query

    const query: Record<string, unknown> = {}

    if (status && status !== 'all') {
      query.applicationStatus = status
    }

    if (search && typeof search === 'string') {
      const regex = new RegExp(search.trim(), 'i')
      query.$or = [
        { fullName: regex },
        { businessEmail: regex },
        { legalName: regex },
        { phone: regex },
      ]
    }

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20))
    const skip = (pageNum - 1) * limitNum

    const [merchants, total] = await Promise.all([
      Merchant.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      Merchant.countDocuments(query),
    ])

    res.status(200).json({
      success: true,
      data: merchants,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get Single Application by ID
export async function getApplicationById(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant application not found.',
      })
    }

    res.status(200).json({
      success: true,
      data: merchant,
    })
  } catch (error) {
    next(error)
  }
}

// Underwriting Decision: Approve / Reject with Custom Offer
export async function reviewApplication(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { status, offer, notes } = req.body

    if (!['approved', 'rejected', 'under_review'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be "approved", "rejected", or "under_review".',
      })
    }

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant application not found.',
      })
    }

    merchant.applicationStatus = status

    let offerWasProvided = false
    if (offer && typeof offer === 'object') {
      offerWasProvided = true
      const isNowAvailable = offer.isAvailable !== undefined ? Boolean(offer.isAvailable) : true
      merchant.offer = {
        rate: offer.rate || merchant.offer?.rate || '2.9% + $0.30',
        volume: offer.volume || merchant.offer?.volume || 'Up to $250,000',
        settlement: offer.settlement || merchant.offer?.settlement || 'Daily (Next Day)',
        reserve: offer.reserve || merchant.offer?.reserve || '5% (90 Days)',
        isAvailable: isNowAvailable,
        accepted: offer.accepted !== undefined ? Boolean(offer.accepted) : (merchant.offer?.accepted || false),
        acceptedAt: merchant.offer?.acceptedAt,
      }
    }

    await merchant.save()

    // Create In-App Notification for the Merchant
    let notifTitle = 'Application Status Updated'
    let notifContent = notes || `Your merchant application status is now ${status.toUpperCase()}.`
    const labels = [status === 'approved' ? 'Approved' : status === 'rejected' ? 'Declined' : 'Underwriting']

    if (status === 'approved') {
      notifTitle = 'Application Approved & Offer Live! 🎉'
      notifContent =
        notes ||
        `Congratulations! Your merchant account for ${merchant.legalName || merchant.fullName} has been approved. Your custom processing rates (${merchant.offer?.rate || 'Tier 1'}) are available. Please accept to proceed.`
      labels.push('Offer Active')
    } else if (offerWasProvided && merchant.offer?.isAvailable) {
      notifTitle = 'Processing Offer Submitted! 📋'
      notifContent =
        notes ||
        `PGX Underwriting has generated your processing offer (${merchant.offer.rate}, ${merchant.offer.volume}). Please view your offer and accept to proceed.`
      labels.push('Offer Available')
    } else if (status === 'rejected') {
      notifTitle = 'Application Update'
      notifContent =
        notes ||
        'Your merchant application could not be approved at this time. Please contact our underwriting desk for assistance.'
      labels.push('Action Required')
    }

    const notification = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'system',
      senderName: 'PGX Underwriting Team',
      title: notifTitle,
      content: notifContent,
      type: (status === 'approved' || (offerWasProvided && merchant.offer?.isAvailable)) ? 'offer' : 'compliance',
      priority: (status === 'approved' || (offerWasProvided && merchant.offer?.isAvailable)) ? 'high' : 'normal',
      labels,
      isRead: false,
    })

    const unreadCount = await Notification.countDocuments({
      merchantId: merchant._id,
      isRead: false,
    })

    // Instant Real-time WebSocket Emission to the Merchant's Room
    emitToMerchant(String(merchant._id), WS_EVENTS.APPLICATION_UPDATED, {
      applicationStatus: merchant.applicationStatus,
      currentStep: merchant.currentStep,
      offer: merchant.offer,
      timestamp: new Date().toISOString(),
    })

    emitToMerchant(String(merchant._id), WS_EVENTS.OFFER_UPDATED, {
      offer: merchant.offer,
      timestamp: new Date().toISOString(),
    })

    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_NOTIFICATION, {
      notification,
      unreadCount,
    })

    res.status(200).json({
      success: true,
      message: `Merchant application ${status} successfully.`,
      data: merchant,
    })
  } catch (error) {
    next(error)
  }
}

// Admin Metrics & Stats
export async function getAdminStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const [total, pending, approved, rejected] = await Promise.all([
      Merchant.countDocuments(),
      Merchant.countDocuments({ applicationStatus: 'under_review' }),
      Merchant.countDocuments({ applicationStatus: 'approved' }),
      Merchant.countDocuments({ applicationStatus: 'rejected' }),
    ])

    res.status(200).json({
      success: true,
      data: {
        totalMerchants: total,
        pendingReview: pending,
        approved,
        rejected,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get System Branding & Settings
export async function getSystemConfig(_req: Request, res: Response, next: NextFunction) {
  try {
    let configDoc = await SystemConfig.findOne()
    if (!configDoc) {
      configDoc = await SystemConfig.create({
        siteName: 'PGX Gateway',
        logoUrl: '',
        faviconUrl: '/favicon.svg',
        supportEmail: 'support@pgxgateway.com',
        supportPhone: '+1 (800) 749-4283',
        supportTelegram: '@pgxsupport',
        supportWhatsapp: '+1 (800) 749-4283',
      })
    }
    res.status(200).json({
      success: true,
      data: configDoc,
    })
  } catch (error) {
    next(error)
  }
}

// Update System Branding & Settings (Admin Only)
export async function updateSystemConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { siteName, logoUrl, faviconUrl, supportEmail, supportPhone, supportTelegram, supportWhatsapp } = req.body

    let configDoc = await SystemConfig.findOne()
    if (!configDoc) {
      configDoc = new SystemConfig()
    }

    if (siteName !== undefined) configDoc.siteName = siteName.trim()
    if (logoUrl !== undefined) configDoc.logoUrl = logoUrl.trim()
    if (faviconUrl !== undefined) configDoc.faviconUrl = faviconUrl.trim()
    if (supportEmail !== undefined) configDoc.supportEmail = supportEmail.trim()
    if (supportPhone !== undefined) configDoc.supportPhone = supportPhone.trim()
    if (supportTelegram !== undefined) configDoc.supportTelegram = supportTelegram.trim()
    if (supportWhatsapp !== undefined) configDoc.supportWhatsapp = supportWhatsapp.trim()

    await configDoc.save()

    res.status(200).json({
      success: true,
      message: 'Branding and system settings updated successfully.',
      data: configDoc,
    })
  } catch (error) {
    next(error)
  }
}

// Send Direct Message from Admin to a Merchant (Powers two-way messaging & instant WebSocket sync)
export async function sendMessageToMerchant(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const {
      title,
      content,
      type = 'general',
      priority = 'normal',
      labels = ['Underwriting'],
      replyTo = null,
    } = req.body

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: 'Title and message content are required.',
      })
    }

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found.',
      })
    }

    const sanitizedLabels = Array.isArray(labels) && labels.length > 0 ? labels : ['Underwriting']

    const notification = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'admin',
      senderName: 'PGX Underwriting Desk',
      title: title.trim(),
      content: content.trim(),
      type: ['system', 'offer', 'document', 'general', 'compliance', 'support'].includes(type)
        ? type
        : 'general',
      priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
      labels: sanitizedLabels,
      replyTo: replyTo || null,
      isRead: false,
    })

    const unreadCount = await Notification.countDocuments({
      merchantId: merchant._id,
      isRead: false,
    })

    // Instant Real-time WebSocket Emission to the Merchant's Room
    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_NOTIFICATION, {
      notification,
      unreadCount,
    })

    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_MESSAGE, {
      notification,
      unreadCount,
    })

    // Also inform other admins in the desk
    emitToAdmins(WS_EVENTS.NEW_MESSAGE, {
      message: notification,
      merchantId: merchant._id,
    })

    res.status(201).json({
      success: true,
      message: 'Message delivered to merchant in real-time.',
      data: notification,
    })
  } catch (error) {
    next(error)
  }
}

// Get All Messages/Inquiries for a Specific Merchant
export async function getMerchantMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const messages = await Notification.find({ merchantId: id }).sort({ createdAt: -1 })

    res.status(200).json({
      success: true,
      data: messages,
    })
  } catch (error) {
    next(error)
  }
}

// Get All Messages Across All Merchants for Admin Center
export async function getAllMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, unreadOnly } = req.query
    const query: Record<string, unknown> = {}

    if (type && type !== 'all') {
      query.type = type
    }

    if (unreadOnly === 'true') {
      query.isRead = false
    }

    const messages = await Notification.find(query)
      .populate('merchantId', 'fullName businessEmail legalName phone')
      .sort({ createdAt: -1 })
      .limit(100)

    res.status(200).json({
      success: true,
      data: messages,
    })
  } catch (error) {
    next(error)
  }
}

// Upload Branding Asset (Logo or Favicon) directly to Cloudinary
export async function uploadBrandingAsset(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file provided for upload.',
      })
    }

    const file = req.file
    const folder = (req.body?.folder as string) || 'pgxgateway/branding'
    const cloudRes = await uploadBufferToCloudinary(file.buffer, file.originalname, folder)

    res.status(200).json({
      success: true,
      message: 'Asset uploaded to Cloudinary successfully.',
      data: {
        url: cloudRes.url,
        publicId: cloudRes.publicId,
        format: cloudRes.format,
        bytes: cloudRes.bytes,
        name: file.originalname,
      },
    })
  } catch (error) {
    next(error)
  }
}


// ----------------------------------------------------------------------
// Multi-Tenant Reseller & Single-Stripe Routing Controller Methods
// ----------------------------------------------------------------------

// Get Reseller's Stripe Configuration & Merchant Fee Settings
export async function getResellerStripeConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const resellerId = (req.query.resellerId as string) || 'admin_root'

    let configDoc = await ResellerConfig.findOne({ resellerId })
    if (!configDoc) {
      configDoc = await ResellerConfig.create({
        resellerId,
        stripe: {
          publishableKey: '',
          secretKey: '',
          webhookSecret: '',
          isConfigured: false,
          mode: 'test',
        },
        feeSettings: {
          basePlatformFee: 9.0, // Hardwired 9%
          merchantFeeRate: 12.0,
        },
      })
    }

    // Mask secret keys for security in UI responses
    const maskedSecret = configDoc.stripe?.secretKey
      ? `••••••••••••${configDoc.stripe.secretKey.slice(-4)}`
      : ''
    const maskedWebhook = configDoc.stripe?.webhookSecret
      ? `••••••••••••${configDoc.stripe.webhookSecret.slice(-4)}`
      : ''

    res.status(200).json({
      success: true,
      data: {
        resellerId: configDoc.resellerId,
        stripe: {
          publishableKey: configDoc.stripe?.publishableKey || '',
          secretKeyMasked: maskedSecret,
          hasSecretKey: Boolean(configDoc.stripe?.secretKey),
          webhookSecretMasked: maskedWebhook,
          hasWebhookSecret: Boolean(configDoc.stripe?.webhookSecret),
          isConfigured: configDoc.stripe?.isConfigured || false,
          mode: configDoc.stripe?.mode || 'test',
        },
        feeSettings: {
          basePlatformFee: 9.0, // Hardwired
          merchantFeeRate: configDoc.feeSettings?.merchantFeeRate || 12.0,
        },
        totalVolumeProcessed: configDoc.totalVolumeProcessed || 0,
        totalPlatformFeesEarned: configDoc.totalPlatformFeesEarned || 0,
        totalResellerProfit: configDoc.totalResellerProfit || 0,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Update Reseller's Stripe Configuration & Fee Settings
export async function updateResellerStripeConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const resellerId = (req.body.resellerId as string) || 'admin_root'
    const { publishableKey, secretKey, webhookSecret, mode, merchantFeeRate } = req.body

    let configDoc = await ResellerConfig.findOne({ resellerId })
    if (!configDoc) {
      configDoc = new ResellerConfig({ resellerId })
    }

    if (publishableKey !== undefined) {
      configDoc.stripe.publishableKey = publishableKey.trim()
    }

    // Only overwrite secret key if user actually typed a new one (not masked)
    if (secretKey && !secretKey.includes('••••')) {
      configDoc.stripe.secretKey = secretKey.trim()
    }

    if (webhookSecret && !webhookSecret.includes('••••')) {
      configDoc.stripe.webhookSecret = webhookSecret.trim()
    }

    if (mode && ['test', 'live'].includes(mode)) {
      configDoc.stripe.mode = mode
    }

    // Enforce Hardwired 9.0% Platform Fee Constraint
    if (merchantFeeRate !== undefined) {
      const rateNum = parseFloat(merchantFeeRate)
      if (isNaN(rateNum) || rateNum < 9.0) {
        return res.status(400).json({
          success: false,
          message: 'Merchant fee rate cannot be set lower than the hardwired 9.0% platform base fee.',
        })
      }
      configDoc.feeSettings.merchantFeeRate = rateNum
    }

    configDoc.stripe.isConfigured = Boolean(
      configDoc.stripe.publishableKey && configDoc.stripe.secretKey
    )

    await configDoc.save()

    res.status(200).json({
      success: true,
      message: 'Gateway configuration and fee parameters updated successfully.',
      data: {
        isConfigured: configDoc.stripe.isConfigured,
        mode: configDoc.stripe.mode,
        merchantFeeRate: configDoc.feeSettings.merchantFeeRate,
        basePlatformFee: 9.0,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get All Transactions for Admin & Super Admin Ledger
export async function getAdminTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, search, refId, page = '1', limit = '25' } = req.query

    const query: Record<string, unknown> = {}

    if (status && status !== 'all') {
      query.status = status
    }

    if (refId && typeof refId === 'string') {
      query.merchantRefId = refId.toUpperCase().trim()
    }

    if (search && typeof search === 'string') {
      const regex = new RegExp(search.trim(), 'i')
      query.$or = [
        { transactionId: regex },
        { merchantRefId: regex },
        { customerEmail: regex },
        { customerName: regex },
        { orderId: regex },
      ]
    }

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 25))
    const skip = (pageNum - 1) * limitNum

    const [transactions, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      Transaction.countDocuments(query),
    ])

    res.status(200).json({
      success: true,
      data: transactions,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    })
  } catch (error) {
    next(error)
  }
}

// Super Admin Global Revenue & Platform Analytics
export async function getSuperAdminAnalytics(_req: Request, res: Response, next: NextFunction) {
  try {
    const [totalMerchants, approvedMerchants, txnAgg] = await Promise.all([
      Merchant.countDocuments(),
      Merchant.countDocuments({ applicationStatus: 'approved' }),
      Transaction.aggregate([
        { $match: { status: 'succeeded' } },
        {
          $group: {
            _id: null,
            totalGrossVolume: { $sum: '$grossAmount' },
            totalPlatformFees: { $sum: '$platformFeeAmount' }, // 9% Platform revenue
            totalResellerProfit: { $sum: '$resellerProfitAmount' },
            totalMerchantNet: { $sum: '$merchantNetAmount' },
            totalTransactions: { $sum: 1 },
          },
        },
      ]),
    ])

    const agg = txnAgg[0] || {
      totalGrossVolume: 0,
      totalPlatformFees: 0,
      totalResellerProfit: 0,
      totalMerchantNet: 0,
      totalTransactions: 0,
    }

    res.status(200).json({
      success: true,
      data: {
        totalGrossVolume: Number(agg.totalGrossVolume.toFixed(2)),
        totalPlatformFees: Number(agg.totalPlatformFees.toFixed(2)), // 9% Platform earnings
        totalResellerProfit: Number(agg.totalResellerProfit.toFixed(2)),
        totalMerchantNet: Number(agg.totalMerchantNet.toFixed(2)),
        totalTransactions: agg.totalTransactions,
        totalMerchants,
        approvedMerchants,
        platformFeeRate: 9.0,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Disburse / Record Manual Payout to a Sub-Merchant
export async function markMerchantPayout(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = String(req.params.merchantId)
    const { amount, reference, notes } = req.body

    const merchant = await Merchant.findById(merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    const payoutAmount = parseFloat(amount) || merchant.balance?.netBalance || 0

    await Merchant.findByIdAndUpdate(merchantId, {
      $inc: {
        'balance.netBalance': -payoutAmount,
        'balance.pendingPayout': 0,
      },
    })

    emitToMerchant(merchantId, WS_EVENTS.NEW_NOTIFICATION, {
      title: 'Payout Disbursed',
      message: `A payout of $${payoutAmount.toFixed(2)} has been recorded (${reference || 'Wire/Crypto'}). ${notes || ''}`,
      type: 'system',
      priority: 'high',
    })

    res.status(200).json({
      success: true,
      message: `Payout of $${payoutAmount.toFixed(2)} recorded successfully for ${merchant.legalName || merchant.fullName}.`,
    })
  } catch (error) {
    next(error)
  }
}
