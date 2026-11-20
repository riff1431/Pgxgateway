import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { AdminRequest } from '../middleware/admin.middleware.js'
import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'
import { signToken } from '../utils/jwt.js'
import { Merchant, generateMerchantRefId } from '../models/Merchant.js'
import { Notification } from '../models/Notification.js'
import { SystemConfig } from '../models/SystemConfig.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Transaction } from '../models/Transaction.js'
import { Invoice } from '../models/Invoice.js'
import { SetupMessage } from '../models/SetupMessage.js'
import { emitToMerchant, emitToAdmins, WS_EVENTS } from '../services/socket.service.js'
import { uploadBufferToCloudinary } from '../config/cloudinary.js'
import { triggerManualSubscriptionCycle } from '../services/cron.service.js'
import { executeMerchantMonthlyCharge } from '../services/subscription.service.js'

// Admin / Reseller / Super Admin Login
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

    // 1. Super Admin authentication
    if (normalizedEmail === config.superAdmin.email.toLowerCase()) {
      if (password !== config.superAdmin.password) {
        return res.status(401).json({
          success: false,
          message: 'Invalid administrative credentials.',
        })
      }

      const token = signToken({
        id: 'super_admin_root',
        email: normalizedEmail,
        role: 'super_admin',
      })

      return res.status(200).json({
        success: true,
        message: 'Super Administrator authenticated successfully.',
        token,
        admin: {
          email: normalizedEmail,
          role: 'super_admin',
          name: 'Super Administrator',
        },
      })
    }

    // 2. Root Admin authentication (Fallback / Primary Client)
    if (normalizedEmail === config.admin.email.toLowerCase()) {
      if (password !== config.admin.password) {
        return res.status(401).json({
          success: false,
          message: 'Invalid administrative credentials.',
        })
      }

      const token = signToken({
        id: 'admin_root',
        email: normalizedEmail,
        role: 'admin',
        resellerId: 'admin_root',
      })

      return res.status(200).json({
        success: true,
        message: 'Administrator authenticated successfully.',
        token,
        admin: {
          email: normalizedEmail,
          role: 'admin',
          name: 'Primary Gateway Administrator',
          resellerId: 'admin_root',
        },
      })
    }

    // 3. Dynamic Provisioned Reseller Authentication from Database
    const reseller = await ResellerConfig.findOne({
      $or: [
        { email: normalizedEmail },
        ...(normalizedEmail === 'ceo@arxopay.com' ? [{ resellerId: 'ARXO' }] : []),
      ],
    }).select('+passwordHash')
    if (reseller) {
      if (reseller.status === 'suspended') {
        return res.status(403).json({
          success: false,
          message: 'Your reseller tenant account has been suspended. Please contact platform administration.',
        })
      }

      if (!reseller.passwordHash) {
        return res.status(401).json({
          success: false,
          message: 'Account password has not been initialized. Please contact platform administration.',
        })
      }

      const isMatch = await bcrypt.compare(password, reseller.passwordHash)
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Invalid administrative credentials.',
        })
      }

      const token = signToken({
        id: reseller.resellerId,
        email: reseller.email || normalizedEmail,
        role: 'admin',
        resellerId: reseller.resellerId,
      })

      return res.status(200).json({
        success: true,
        message: 'Reseller administrator authenticated successfully.',
        token,
        admin: {
          email: reseller.email || normalizedEmail,
          role: 'admin',
          name: reseller.name || 'Reseller Partner',
          resellerId: reseller.resellerId,
        },
      })
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid administrative credentials.',
    })
  } catch (error) {
    next(error)
  }
}

// Get Applications List with Filtering & Search
export async function getApplications(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { status, search, page = '1', limit = '20' } = req.query

    const andConditions: Record<string, unknown>[] = []

    // Multi-tenant scoping: Sub-resellers see only their merchants; Root Admin ('admin_root') & Super Admin can view all or filter by reseller
    if (req.admin?.role === 'admin' && req.admin.resellerId && req.admin.resellerId !== 'admin_root') {
      andConditions.push({ resellerId: req.admin.resellerId })
    } else if (req.query.resellerId && req.query.resellerId !== 'all') {
      const targetReseller = String(req.query.resellerId).trim()
      if (targetReseller.toLowerCase() === 'admin_root') {
        andConditions.push({
          $or: [
            { resellerId: 'admin_root' },
            { resellerId: { $exists: false } },
            { resellerId: null },
            { resellerId: '' },
          ],
        })
      } else {
        andConditions.push({
          resellerId: new RegExp(`^${targetReseller}$`, 'i'),
        })
      }
    }

    if (status && status !== 'all') {
      andConditions.push({ applicationStatus: status })
    }

    if (search && typeof search === 'string') {
      const regex = new RegExp(search.trim(), 'i')
      andConditions.push({
        $or: [
          { fullName: regex },
          { businessEmail: regex },
          { legalName: regex },
          { phone: regex },
        ],
      })
    }

    const query = andConditions.length > 0 ? { $and: andConditions } : {}

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20))
    const skip = (pageNum - 1) * limitNum

    const [merchants, total] = await Promise.all([
      Merchant.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      Merchant.countDocuments(query),
    ])

    // Query unread message counts for each merchant sent by merchant that admin hasn't read
    const merchantIds = merchants.map((m) => m._id)
    const unreadAgg = await Notification.aggregate([
      {
        $match: {
          merchantId: { $in: merchantIds },
          senderRole: 'merchant',
          adminRead: { $ne: true },
        },
      },
      {
        $group: {
          _id: '$merchantId',
          count: { $sum: 1 },
        },
      },
    ])
    const unreadMap = new Map<string, number>()
    unreadAgg.forEach((u) => {
      unreadMap.set(String(u._id), u.count)
    })

    const sanitizedMerchants = merchants.map((m) => {
      const doc: any = m.toObject ? m.toObject() : { ...m }
      if (doc.cryptoPayment && (doc.cryptoPayment.amount === 450 || !doc.cryptoPayment.amount)) {
        doc.cryptoPayment.amount = 999
      }
      doc.unreadMessagesCount = unreadMap.get(String(m._id)) || 0
      return doc
    })

    res.status(200).json({
      success: true,
      data: sanitizedMerchants,
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

    // Multi-tenant check: sub-reseller can only view their own merchants
    const adminReq = req as AdminRequest
    if (adminReq.admin?.role === 'admin' && adminReq.admin.resellerId && adminReq.admin.resellerId !== 'admin_root') {
      if (merchant.resellerId !== adminReq.admin.resellerId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You do not have permission to view merchants outside your reseller portfolio.',
        })
      }
    }

    const doc = merchant.toObject ? merchant.toObject() : { ...merchant }
    if (doc.cryptoPayment && (doc.cryptoPayment.amount === 450 || !doc.cryptoPayment.amount)) {
      doc.cryptoPayment.amount = 999
    }

    res.status(200).json({
      success: true,
      data: doc,
    })
  } catch (error) {
    next(error)
  }
}

// Underwriting Decision: Approve / Reject with Custom Offer
export async function reviewApplication(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { status, offer, notes, approveMode, trialHours, assignedBridge } = req.body

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

    // Multi-tenant isolation: Sub-resellers can only review their own merchants
    if (req.admin?.role === 'admin' && req.admin.resellerId && req.admin.resellerId !== 'admin_root') {
      const adminReseller = String(req.admin.resellerId).toLowerCase().trim()
      const merchantReseller = String(merchant.resellerId || 'admin_root').toLowerCase().trim()
      const isArxoMatch =
        (adminReseller === 'arxo' || adminReseller === 'arxopay') &&
        (merchantReseller === 'arxo' || merchantReseller === 'arxopay' || merchant.refId?.toUpperCase().startsWith('ARXO-'))

      if (adminReseller !== merchantReseller && !isArxoMatch) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You do not have permission to review merchants outside your reseller portfolio.',
        })
      }
    }

    merchant.applicationStatus = status

    // Ensure unique standardized refId is generated if missing
    if (!merchant.refId) {
      merchant.refId = await generateMerchantRefId(merchant.resellerId)
    }

    // Role-based Live Activation Gate: Sub-resellers can ONLY approve into 24h Trial
    const isSuperAdmin = req.admin?.role === 'super_admin' || req.admin?.resellerId === 'admin_root'
    const requestedMode = approveMode === 'live' ? 'live' : 'trial'
    const mode = isSuperAdmin ? requestedMode : 'trial'

    if (status === 'approved') {
      if (mode === 'trial') {
        const duration = Number(trialHours) > 0 ? Number(trialHours) : 24
        merchant.accountMode = 'trial'
        merchant.trial = {
          isActive: true,
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + duration * 3600 * 1000),
          trialDurationHours: duration,
          status: 'active',
          maxTestAmount: 100,
        }
      } else {
        merchant.accountMode = 'live'
        merchant.trial = {
          isActive: false,
          startedAt: merchant.trial?.startedAt,
          expiresAt: merchant.trial?.expiresAt,
          trialDurationHours: merchant.trial?.trialDurationHours || 24,
          status: 'converted',
          maxTestAmount: 100,
        }
        merchant.setupStatus = 'paid_setup'

        if (merchant.liveActivationRequest && merchant.liveActivationRequest.status === 'pending') {
          merchant.liveActivationRequest.status = 'approved'
          merchant.liveActivationRequest.reviewedAt = new Date()
          merchant.liveActivationRequest.reviewedBy = req.admin?.email || 'Platform Super Admin'
        }

        // Initialize Arxopay wholesale 30-day maintenance cycle upon going live
        const isArxo = merchant.resellerId === 'ARXO' || merchant.refId?.startsWith('ARXO-')
        if (isArxo) {
          const nextDue = new Date(Date.now() + 30 * 24 * 3600 * 1000)
          merchant.arxopayWholesale = {
            setupFee: {
              amount: 1499,
              currency: merchant.arxopayWholesale?.setupFee?.currency || 'USDT',
              network: merchant.arxopayWholesale?.setupFee?.network || 'TRC-20',
              txHash: merchant.arxopayWholesale?.setupFee?.txHash || '',
              paidAt: merchant.arxopayWholesale?.setupFee?.paidAt || new Date(),
              status: 'verified',
            },
            monthlyMaintenance: {
              amount: 499,
              currency: merchant.arxopayWholesale?.monthlyMaintenance?.currency || 'USDT',
              network: merchant.arxopayWholesale?.monthlyMaintenance?.network || 'TRC-20',
              txHash: merchant.arxopayWholesale?.monthlyMaintenance?.txHash || '',
              lastPaidAt: merchant.arxopayWholesale?.monthlyMaintenance?.lastPaidAt,
              nextDueAt: merchant.arxopayWholesale?.monthlyMaintenance?.nextDueAt || nextDue,
              status: 'current',
            },
          }
        }
      }
    }

    let offerWasProvided = false
    if (offer && typeof offer === 'object') {
      offerWasProvided = true
      const isNowAvailable = offer.isAvailable !== undefined ? Boolean(offer.isAvailable) : true
      merchant.offer = {
        rate: offer.rate || merchant.offer?.rate || '2.9% + $0.30',
        volume: offer.volume || merchant.offer?.volume || 'Up to $250,000',
        settlement: offer.settlement || merchant.offer?.settlement || 'Daily (Next Day)',
        reserve: offer.reserve || merchant.offer?.reserve || '5% (90 Days)',
        setupFee: offer.setupFee !== undefined ? String(offer.setupFee).trim() : (merchant.offer?.setupFee || '$999'),
        monthlyFee: offer.monthlyFee !== undefined ? String(offer.monthlyFee).trim() : (merchant.offer?.monthlyFee || '$99 / month'),
        isAvailable: isNowAvailable,
        accepted: offer.accepted !== undefined ? Boolean(offer.accepted) : (merchant.offer?.accepted || false),
        acceptedAt: merchant.offer?.acceptedAt || ((offer.accepted || merchant.offer?.accepted) ? new Date() : undefined),
      }

      // Automatically sync pending crypto payment amount with the new setup fee offer
      if (merchant.cryptoPayment && merchant.cryptoPayment.status === 'pending') {
        const parsedFee = parseFloat(String(merchant.offer.setupFee).replace(/[^0-9.]/g, ''))
        if (!isNaN(parsedFee) && parsedFee > 0) {
          merchant.cryptoPayment.amount = parsedFee
        }
      }
    }

    const isPlatformRoot =
      req.admin?.role === 'super_admin' ||
      req.admin?.resellerId === 'admin_root' ||
      req.admin?.resellerId === 'super_admin_root'

    if (isPlatformRoot && assignedBridge && ['marketplace', 'leads'].includes(assignedBridge)) {
      merchant.assignedBridge = assignedBridge
    }

    await merchant.save()

    // Create In-App Notification for the Merchant
    let notifTitle = 'Application Status Updated'
    let notifContent = notes || `Your merchant application status is now ${status.toUpperCase()}.`
    const labels = [status === 'approved' ? (mode === 'trial' ? '24h Trial Active' : 'Live Approved') : status === 'rejected' ? 'Declined' : 'Underwriting']

    if (status === 'approved') {
      if (mode === 'trial') {
        notifTitle = 'Application Approved & 24h Integration Trial Active! ⏳'
        notifContent =
          notes ||
          `Congratulations! Your merchant account for ${merchant.legalName || merchant.fullName} has been approved with a 24-Hour Integration Sandbox. Your Merchant Ref ID is ${merchant.refId}. Test your checkout now from the 'API & Integration' tab!`
        labels.push('Sandbox Live')
      } else {
        notifTitle = 'Application Fully Approved (Live Active)! 🎉'
        notifContent =
          notes ||
          `Congratulations! Your merchant account for ${merchant.legalName || merchant.fullName} is fully active for live payment processing. Your Merchant Ref ID is ${merchant.refId}.`
        labels.push('Offer Active')
      }
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
      accountMode: merchant.accountMode,
      trial: merchant.trial,
      refId: merchant.refId,
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

// Extend Merchant 24-Hour Trial (+24h or specified hours)
export async function extendMerchantTrial(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { hours = 24 } = req.body

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    const extensionHours = Number(hours) > 0 ? Number(hours) : 24
    const now = Date.now()
    const currentExpiry = merchant.trial?.expiresAt ? new Date(merchant.trial.expiresAt).getTime() : now
    const baseTime = currentExpiry > now ? currentExpiry : now
    const newExpiresAt = new Date(baseTime + extensionHours * 3600 * 1000)

    merchant.accountMode = 'trial'
    merchant.trial = {
      isActive: true,
      startedAt: merchant.trial?.startedAt || new Date(),
      expiresAt: newExpiresAt,
      trialDurationHours: (merchant.trial?.trialDurationHours || 0) + extensionHours,
      status: 'active',
      maxTestAmount: merchant.trial?.maxTestAmount || 100,
    }

    await merchant.save()

    const notification = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'system',
      senderName: 'PGX Underwriting Team',
      title: 'Integration Trial Extended! ⏳',
      content: `Your integration testing sandbox has been extended by ${extensionHours} hours. You now have until ${newExpiresAt.toUTCString()} to test your hosted checkout.`,
      type: 'compliance',
      priority: 'high',
      labels: ['Trial Extended'],
      isRead: false,
    })

    const unreadCount = await Notification.countDocuments({ merchantId: merchant._id, isRead: false })

    emitToMerchant(String(merchant._id), WS_EVENTS.APPLICATION_UPDATED, {
      applicationStatus: merchant.applicationStatus,
      accountMode: merchant.accountMode,
      trial: merchant.trial,
      refId: merchant.refId,
      timestamp: new Date().toISOString(),
    })

    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_NOTIFICATION, {
      notification,
      unreadCount,
    })

    return res.status(200).json({
      success: true,
      message: `Trial extended by ${extensionHours} hours successfully.`,
      data: merchant,
    })
  } catch (error) {
    next(error)
  }
}

// Convert Merchant Directly to Live (Super Admin Authority Only)
export async function convertMerchantToLive(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const isSuperAdmin = req.admin?.role === 'super_admin' || req.admin?.resellerId === 'admin_root'
    if (!isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only Platform Super Administrator can authorize permanent Live account conversion. Please submit a Live Activation Request.',
      })
    }

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    merchant.accountMode = 'live'
    merchant.trial = {
      isActive: false,
      startedAt: merchant.trial?.startedAt,
      expiresAt: merchant.trial?.expiresAt,
      trialDurationHours: merchant.trial?.trialDurationHours || 24,
      status: 'converted',
      maxTestAmount: 100,
    }
    merchant.setupStatus = 'paid_setup'

    if (merchant.liveActivationRequest && merchant.liveActivationRequest.status === 'pending') {
      merchant.liveActivationRequest.status = 'approved'
      merchant.liveActivationRequest.reviewedAt = new Date()
      merchant.liveActivationRequest.reviewedBy = req.admin?.email || 'Platform Super Admin'
    }

    // Initialize Arxopay wholesale 30-day maintenance cycle upon going live
    const isArxo = merchant.resellerId === 'ARXO' || merchant.refId?.startsWith('ARXO-')
    if (isArxo) {
      const nextDue = new Date(Date.now() + 30 * 24 * 3600 * 1000)
      merchant.arxopayWholesale = {
        setupFee: {
          amount: 1499,
          currency: merchant.arxopayWholesale?.setupFee?.currency || 'USDT',
          network: merchant.arxopayWholesale?.setupFee?.network || 'TRC-20',
          txHash: merchant.arxopayWholesale?.setupFee?.txHash || '',
          paidAt: merchant.arxopayWholesale?.setupFee?.paidAt || new Date(),
          status: 'verified',
        },
        monthlyMaintenance: {
          amount: 499,
          currency: merchant.arxopayWholesale?.monthlyMaintenance?.currency || 'USDT',
          network: merchant.arxopayWholesale?.monthlyMaintenance?.network || 'TRC-20',
          txHash: merchant.arxopayWholesale?.monthlyMaintenance?.txHash || '',
          lastPaidAt: merchant.arxopayWholesale?.monthlyMaintenance?.lastPaidAt,
          nextDueAt: merchant.arxopayWholesale?.monthlyMaintenance?.nextDueAt || nextDue,
          status: 'current',
        },
      }
    }

    await merchant.save()

    const notification = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'system',
      senderName: 'PGX Underwriting Team',
      title: 'Account Converted to Full Live! 🚀',
      content: `Your merchant account for ${merchant.legalName || merchant.fullName} has been granted Full Live processing status with no volume limits.`,
      type: 'compliance',
      priority: 'high',
      labels: ['Live Processing'],
      isRead: false,
    })

    const unreadCount = await Notification.countDocuments({ merchantId: merchant._id, isRead: false })

    emitToMerchant(String(merchant._id), WS_EVENTS.APPLICATION_UPDATED, {
      applicationStatus: merchant.applicationStatus,
      accountMode: merchant.accountMode,
      trial: merchant.trial,
      setupStatus: merchant.setupStatus,
      liveActivationRequest: merchant.liveActivationRequest,
      refId: merchant.refId,
      timestamp: new Date().toISOString(),
    })

    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_NOTIFICATION, {
      notification,
      unreadCount,
    })

    return res.status(200).json({
      success: true,
      message: 'Merchant converted to Live processing successfully.',
      data: merchant,
    })
  } catch (error) {
    next(error)
  }
}

// Request Live Activation (Sub-Reseller requests Super Admin sign-off)
export async function requestMerchantLiveActivation(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { notes, txHash, currency = 'USDT', network = 'TRC-20' } = req.body

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant application not found.' })
    }

    // Portfolio scoping: Resellers can only request for their own sub-merchants
    if (req.admin?.role === 'admin' && req.admin.resellerId && req.admin.resellerId !== 'admin_root') {
      const adminReseller = String(req.admin.resellerId).toLowerCase().trim()
      const merchantReseller = String(merchant.resellerId || 'admin_root').toLowerCase().trim()
      const isArxoMatch =
        (adminReseller === 'arxo' || adminReseller === 'arxopay') &&
        (merchantReseller === 'arxo' || merchantReseller === 'arxopay' || merchant.refId?.toUpperCase().startsWith('ARXO-'))

      if (adminReseller !== merchantReseller && !isArxoMatch) {
        return res.status(403).json({ success: false, message: 'Unauthorized. Merchant belongs to another partner portfolio.' })
      }
    }

    if (merchant.accountMode === 'live') {
      return res.status(400).json({ success: false, message: 'Merchant is already active in permanent Live mode.' })
    }

    merchant.liveActivationRequest = {
      isRequested: true,
      requestedAt: new Date(),
      requestedByResellerId: req.admin?.resellerId || merchant.resellerId || 'reseller',
      notes: notes || (txHash ? `Arxopay paid $1499 Go-Live Setup Fee via ${currency} (${network}). TxID: ${txHash}` : 'Partner requested full live processing after trial verification.'),
      status: 'pending',
    }

    // If txHash or Arxopay merchant, record setup crypto payment
    const isArxo = merchant.resellerId === 'ARXO' || merchant.refId?.startsWith('ARXO-')
    if (txHash || isArxo) {
      merchant.arxopayWholesale = {
        ...merchant.arxopayWholesale,
        setupFee: {
          amount: 1499,
          currency: currency || 'USDT',
          network: network || 'TRC-20',
          txHash: String(txHash || '').trim(),
          paidAt: new Date(),
          status: txHash ? 'pending' : 'none',
        },
      }
    }

    await merchant.save()

    const notification = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'system',
      senderName: 'PGX Underwriting Team',
      title: 'Live Activation Request Submitted! ⚡',
      content: `A permanent live processing request for ${merchant.legalName || merchant.fullName} has been submitted for Super Admin review. Expected turnaround SLA: <24 hours.`,
      type: 'compliance',
      priority: 'high',
      labels: ['Live Requested'],
      isRead: false,
    })

    const unreadCount = await Notification.countDocuments({ merchantId: merchant._id, isRead: false })

    emitToMerchant(String(merchant._id), WS_EVENTS.APPLICATION_UPDATED, {
      applicationStatus: merchant.applicationStatus,
      accountMode: merchant.accountMode,
      trial: merchant.trial,
      liveActivationRequest: merchant.liveActivationRequest,
      refId: merchant.refId,
      timestamp: new Date().toISOString(),
    })

    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_NOTIFICATION, {
      notification,
      unreadCount,
    })

    return res.status(200).json({
      success: true,
      message: 'Live activation request submitted successfully. Super Admin review turnaround is within 24 hours.',
      data: merchant,
    })
  } catch (error) {
    next(error)
  }
}

// Submit Arxopay Monthly Maintenance Crypto Payment ($499 via Crypto)
export async function submitMonthlyCryptoPayment(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { txHash, currency = 'USDT', network = 'TRC-20' } = req.body

    if (!txHash) {
      return res.status(400).json({ success: false, message: 'Transaction Hash (TxID) is required.' })
    }

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    // Portfolio scoping: Resellers can only submit for their own sub-merchants
    if (req.admin?.role === 'admin' && req.admin.resellerId && req.admin.resellerId !== 'admin_root') {
      const adminReseller = String(req.admin.resellerId).toLowerCase().trim()
      const merchantReseller = String(merchant.resellerId || 'admin_root').toLowerCase().trim()
      const isArxoMatch =
        (adminReseller === 'arxo' || adminReseller === 'arxopay') &&
        (merchantReseller === 'arxo' || merchantReseller === 'arxopay' || merchant.refId?.toUpperCase().startsWith('ARXO-'))

      if (adminReseller !== merchantReseller && !isArxoMatch) {
        return res.status(403).json({ success: false, message: 'Unauthorized. Merchant belongs to another partner portfolio.' })
      }
    }

    const currentNextDue = merchant.arxopayWholesale?.monthlyMaintenance?.nextDueAt
    const baseDate = currentNextDue && new Date(currentNextDue) > new Date() ? new Date(currentNextDue) : new Date()
    const nextDueAt = new Date(baseDate.getTime() + 30 * 24 * 3600 * 1000)

    merchant.arxopayWholesale = {
      ...merchant.arxopayWholesale,
      monthlyMaintenance: {
        amount: 499,
        currency,
        network,
        txHash: String(txHash).trim(),
        lastPaidAt: new Date(),
        nextDueAt,
        status: 'pending_verification',
      },
    }

    await merchant.save()

    return res.status(200).json({
      success: true,
      message: 'Monthly maintenance payment of $499 submitted for verification. Next cycle set.',
      monthlyMaintenance: merchant.arxopayWholesale.monthlyMaintenance,
    })
  } catch (error) {
    next(error)
  }
}

// Super Admin rejects Live Activation Request with reason
export async function rejectMerchantLiveActivation(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { reason } = req.body

    const isSuperAdmin = req.admin?.role === 'super_admin' || req.admin?.resellerId === 'admin_root'
    if (!isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Only Super Admin can decline live activation requests.' })
    }

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    if (merchant.liveActivationRequest) {
      merchant.liveActivationRequest.status = 'rejected'
      merchant.liveActivationRequest.reviewedAt = new Date()
      merchant.liveActivationRequest.reviewedBy = req.admin?.email || 'Platform Super Admin'
      merchant.liveActivationRequest.rejectionReason = reason || 'Declined due to underwriting policy.'
    }

    await merchant.save()

    return res.status(200).json({
      success: true,
      message: 'Live activation request declined.',
      data: merchant,
    })
  } catch (error) {
    next(error)
  }
}

// Delete Merchant Application & Cascade Associated Records (Test Account Cleanup)
export async function deleteMerchantApplication(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant application not found.',
      })
    }

    // Multi-tenant scoping: Resellers can only delete merchants belonging to their own tenant; Root Admin & Super Admin can delete all
    if (req.admin?.role === 'admin' && req.admin.resellerId && req.admin.resellerId !== 'admin_root') {
      const adminReseller = String(req.admin.resellerId).toLowerCase().trim()
      const merchantReseller = String(merchant.resellerId || 'admin_root').toLowerCase().trim()
      const isArxoMatch =
        (adminReseller === 'arxo' || adminReseller === 'arxopay') &&
        (merchantReseller === 'arxo' || merchantReseller === 'arxopay' || merchant.refId?.toUpperCase().startsWith('ARXO-'))

      if (adminReseller !== merchantReseller && !isArxoMatch) {
        return res.status(403).json({
          success: false,
          message: 'Access denied: You can only delete merchant applications within your assigned reseller tenant.',
        })
      }
    }

    const merchantRef = merchant.refId || merchant.legalName || merchant.fullName || id

    // Cascade delete related records across all collections in parallel
    await Promise.allSettled([
      Invoice.deleteMany({ merchantId: id }),
      Transaction.deleteMany({ $or: [{ merchantId: id }, { merchantId: String(id) }, { merchantRefId: merchant.refId }] }),
      Notification.deleteMany({ merchantId: id }),
      SetupMessage.deleteMany({ merchantId: id }),
    ])

    await Merchant.findByIdAndDelete(id)

    // Notify connected admin sessions via WebSocket to refresh tables
    emitToAdmins(WS_EVENTS.APPLICATION_UPDATED, {
      action: 'deleted',
      merchantId: id,
      timestamp: new Date().toISOString(),
    })

    return res.status(200).json({
      success: true,
      message: `Merchant application (${merchantRef}) and all associated records have been permanently deleted.`,
    })
  } catch (error) {
    next(error)
  }
}

// Admin Metrics & Stats — multi-tenant scoped for resellers
export async function getAdminStats(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const andConditions: Record<string, unknown>[] = []

    // Multi-tenant scoping: Sub-resellers see only their transactions/merchants; Root Admin & Super Admin see all or filtered
    if (req.admin?.role === 'admin' && req.admin.resellerId && req.admin.resellerId !== 'admin_root') {
      andConditions.push({ resellerId: req.admin.resellerId })
    } else if (req.query.resellerId && req.query.resellerId !== 'all') {
      const targetReseller = String(req.query.resellerId).trim()
      if (targetReseller.toLowerCase() === 'admin_root') {
        andConditions.push({
          $or: [
            { resellerId: 'admin_root' },
            { resellerId: { $exists: false } },
            { resellerId: null },
            { resellerId: '' },
          ],
        })
      } else {
        andConditions.push({
          resellerId: new RegExp(`^${targetReseller}$`, 'i'),
        })
      }
    }

    const scope = andConditions.length > 0 ? { $and: andConditions } : {}

    const [total, pending, approved, rejected] = await Promise.all([
      Merchant.countDocuments(scope),
      Merchant.countDocuments({ ...scope, applicationStatus: 'under_review' }),
      Merchant.countDocuments({ ...scope, applicationStatus: 'approved' }),
      Merchant.countDocuments({ ...scope, applicationStatus: 'rejected' }),
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
        supportWhatsapp: '+1 (437) 577-8785',
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

    // Multi-tenant check: sub-resellers can only message their own merchants
    const adminReq = req as AdminRequest
    if (adminReq.admin?.role === 'admin' && adminReq.admin.resellerId && adminReq.admin.resellerId !== 'admin_root') {
      if (merchant.resellerId !== adminReq.admin.resellerId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You cannot message merchants outside your reseller portfolio.',
        })
      }
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
      adminRead: true, // Created by admin
      adminReadAt: new Date(),
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

    const adminReq = req as AdminRequest
    if (adminReq.admin?.role === 'admin' && adminReq.admin.resellerId && adminReq.admin.resellerId !== 'admin_root') {
      const merchant = await Merchant.findById(id).select('resellerId')
      if (!merchant || merchant.resellerId !== adminReq.admin.resellerId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You cannot view messages for merchants outside your reseller portfolio.',
        })
      }
    }

    // Mark unread merchant messages as read by admin upon opening the desk thread
    await Notification.updateMany(
      { merchantId: id, senderRole: 'merchant', adminRead: { $ne: true } },
      { $set: { adminRead: true, adminReadAt: new Date() } }
    )

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

    const adminReq = req as AdminRequest
    if (adminReq.admin?.role === 'admin' && adminReq.admin.resellerId && adminReq.admin.resellerId !== 'admin_root') {
      const resellerMerchants = await Merchant.find({ resellerId: adminReq.admin.resellerId }).select('_id')
      const merchantIds = resellerMerchants.map((m) => m._id)
      query.merchantId = { $in: merchantIds }
    }

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
export async function getResellerStripeConfig(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const resellerId = req.admin?.role === 'super_admin' ? ((req.query.resellerId as string) || 'admin_root') : (req.admin?.resellerId || 'admin_root')

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
          basePlatformFee: 9.0, // Default 9%
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
export async function updateResellerStripeConfig(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const resellerId = req.admin?.role === 'super_admin' ? ((req.body.resellerId as string) || 'admin_root') : (req.admin?.resellerId || 'admin_root')
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

    // Enforce Dynamic Platform Fee Constraint
    if (merchantFeeRate !== undefined) {
      const rateNum = parseFloat(merchantFeeRate)
      const baseFee = configDoc.feeSettings?.basePlatformFee ?? 9.0
      if (isNaN(rateNum) || rateNum < baseFee) {
        return res.status(400).json({
          success: false,
          message: `Merchant fee rate cannot be set lower than your base platform fee (${baseFee.toFixed(1)}%).`,
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
export async function getAdminTransactions(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { status, search, refId, page = '1', limit = '25' } = req.query

    const andConditions: Record<string, unknown>[] = []

    if (req.admin?.role === 'admin' && req.admin.resellerId && req.admin.resellerId !== 'admin_root') {
      andConditions.push({ resellerId: req.admin.resellerId })
    } else if (req.query.resellerId && req.query.resellerId !== 'all') {
      const targetReseller = String(req.query.resellerId).trim()
      if (targetReseller.toLowerCase() === 'admin_root') {
        andConditions.push({
          $or: [
            { resellerId: 'admin_root' },
            { resellerId: { $exists: false } },
            { resellerId: null },
            { resellerId: '' },
          ],
        })
      } else {
        andConditions.push({
          resellerId: new RegExp(`^${targetReseller}$`, 'i'),
        })
      }
    }

    if (status && status !== 'all') {
      andConditions.push({ status })
    }

    if (refId && typeof refId === 'string') {
      andConditions.push({ merchantRefId: refId.toUpperCase().trim() })
    }

    if (search && typeof search === 'string') {
      const regex = new RegExp(search.trim(), 'i')
      const matchingMerchants = await Merchant.find({
        $or: [{ fullName: regex }, { legalName: regex }],
      })
        .select('_id refId')
        .lean()

      const matchedMIds = matchingMerchants.map((m) => m._id)
      const matchedRefIds = matchingMerchants.map((m) => m.refId).filter(Boolean)

      andConditions.push({
        $or: [
          { transactionId: regex },
          { merchantRefId: regex },
          { customerEmail: regex },
          { customerName: regex },
          { orderId: regex },
          ...(matchedMIds.length > 0 ? [{ merchantId: { $in: matchedMIds } }] : []),
          ...(matchedRefIds.length > 0 ? [{ merchantRefId: { $in: matchedRefIds } }] : []),
        ],
      })
    }

    const query = andConditions.length > 0 ? { $and: andConditions } : {}

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 25))
    const skip = (pageNum - 1) * limitNum

    const [transactions, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      Transaction.countDocuments(query),
    ])

    // Resolve merchant names for all transactions
    const merchantIds = transactions.map((t) => t.merchantId).filter(Boolean)
    const merchantRefIds = transactions.map((t) => t.merchantRefId).filter(Boolean)

    const merchants = await Merchant.find({
      $or: [
        { _id: { $in: merchantIds } },
        { refId: { $in: merchantRefIds } },
      ],
    })
      .select('_id refId fullName legalName')
      .lean()

    const merchantMapById = new Map<string, string>()
    const merchantMapByRef = new Map<string, string>()

    merchants.forEach((m) => {
      const name = (m.legalName || m.fullName || '').trim()
      if (name) {
        merchantMapById.set(String(m._id), name)
        if (m.refId) {
          merchantMapByRef.set(m.refId.toUpperCase().trim(), name)
        }
      }
    })

    const enrichedTransactions = transactions.map((t) => {
      const doc = t.toObject ? t.toObject() : { ...t }
      const resolvedName =
        merchantMapById.get(String(t.merchantId)) ||
        (t.merchantRefId ? merchantMapByRef.get(t.merchantRefId.toUpperCase().trim()) : '') ||
        'Direct Merchant'
      return {
        ...doc,
        merchantName: resolvedName,
      }
    })

    res.status(200).json({
      success: true,
      data: enrichedTransactions,
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
export async function getSuperAdminAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const period = ((req.query.period as string) || 'all').toLowerCase()
    let startDate: Date | null = null
    let endDate: Date | null = null

    const now = new Date()

    if (period === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    } else if (period === 'yesterday') {
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)
      startDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 0, 0, 0)
      endDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999)
    } else if (period === 'week' || period === 'this_week') {
      const day = now.getDay()
      const diffToMonday = (day === 0 ? -6 : 1) - day
      startDate = new Date(now)
      startDate.setDate(now.getDate() + diffToMonday)
      startDate.setHours(0, 0, 0, 0)
      endDate = new Date()
    } else if (period === 'month' || period === 'this_month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0)
      endDate = new Date()
    } else if (period === 'ytd') {
      startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0)
      endDate = new Date()
    }

    const txnMatch: Record<string, unknown> = { status: 'succeeded' }
    if (startDate) {
      txnMatch.createdAt = {
        $gte: startDate,
        ...(endDate ? { $lte: endDate } : {}),
      }
    }

    const merchantFilter: Record<string, unknown> = { applicationStatus: 'approved' }
    if (startDate) {
      merchantFilter.createdAt = {
        $gte: startDate,
        ...(endDate ? { $lte: endDate } : {}),
      }
    }

    const [totalMerchants, approvedMerchants, resellers, txnAgg, approvedList] = await Promise.all([
      Merchant.countDocuments(),
      Merchant.countDocuments({ applicationStatus: 'approved' }),
      ResellerConfig.find().select('resellerId stripe.mode stripe.isConfigured feeSettings totalVolumeProcessed totalPlatformFeesEarned totalResellerProfit updatedAt'),
      Transaction.aggregate([
        { $match: txnMatch },
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
      Merchant.find(period === 'all' || period === 'ytd' ? { applicationStatus: 'approved' } : merchantFilter).select('setupFeeAmount offer subscription tier'),
    ])

    const agg = txnAgg[0] || {
      totalGrossVolume: 0,
      totalPlatformFees: 0,
      totalResellerProfit: 0,
      totalMerchantNet: 0,
      totalTransactions: 0,
    }

    let totalSetupFees = 0
    let totalMonthlyRecurring = 0

    for (const m of approvedList) {
      let sFee = m.setupFeeAmount || 0
      if (!sFee && m.offer?.setupFee) {
        const parsed = parseFloat(m.offer.setupFee.replace(/[^0-9.]/g, ''))
        if (!isNaN(parsed) && parsed > 0) sFee = parsed
      }
      if (!sFee) {
        sFee = m.offer?.tier === 2 ? 2500 : 1499
      }
      totalSetupFees += sFee

      let mFee = m.subscription?.monthlyFee || 0
      if (!mFee && m.offer?.monthlyFee) {
        const parsedM = parseFloat(m.offer.monthlyFee.replace(/[^0-9.]/g, ''))
        if (!isNaN(parsedM) && parsedM > 0) mFee = parsedM
      }
      if (!mFee) {
        mFee = 499
      }
      totalMonthlyRecurring += mFee
    }

    const totalPlatformRevenue = Number((agg.totalPlatformFees + totalSetupFees + totalMonthlyRecurring).toFixed(2))

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
        totalSetupFees: Number(totalSetupFees.toFixed(2)),
        totalMonthlyRecurring: Number(totalMonthlyRecurring.toFixed(2)),
        totalPlatformRevenue,
        period,
        resellers,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Disburse / Record Manual Payout to a Sub-Merchant (Daily Deposit)
export async function markMerchantPayout(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = String(req.params.merchantId)
    const { amount, method, destination, reference, notes, adminName } = req.body

    const merchant = await Merchant.findById(merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    const payoutAmount = parseFloat(amount)
    if (isNaN(payoutAmount) || payoutAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Please provide a valid payout amount.' })
    }

    const payoutMethod: 'crypto_usdc' | 'bank_swift' =
      method === 'bank_swift' ? 'bank_swift' : 'crypto_usdc'
    const payoutId = `PAYOUT_${Date.now().toString().slice(-6)}_${crypto.randomBytes(2).toString('hex').toUpperCase()}`

    // Deduct from balance
    if (!merchant.balance) {
      merchant.balance = { grossVolume: 0, netBalance: 0, totalFeesPaid: 0, pendingPayout: 0 }
    }
    merchant.balance.netBalance = Math.max(0, (merchant.balance.netBalance || 0) - payoutAmount)
    merchant.balance.pendingPayout = 0

    // Append to payoutHistory
    if (!merchant.payoutHistory) {
      merchant.payoutHistory = []
    }

    const payoutRecord = {
      payoutId,
      amount: payoutAmount,
      method: payoutMethod,
      destination: destination || (payoutMethod === 'crypto_usdc' ? merchant.payoutSettings?.cryptoUsdc?.address : merchant.payoutSettings?.bankSwift?.ibanOrAccountNumber) || '',
      reference: reference || 'Daily Settlement Wire/USDC',
      status: 'completed' as const,
      notes: notes || '',
      adminName: adminName || 'Settlement Desk',
      depositedAt: new Date(),
    }

    merchant.payoutHistory.push(payoutRecord)
    await merchant.save()

    emitToMerchant(merchantId, WS_EVENTS.NEW_NOTIFICATION, {
      title: 'Daily Deposit Sent & Confirmed',
      message: `A settlement deposit of $${payoutAmount.toFixed(2)} has been sent via ${payoutMethod === 'crypto_usdc' ? 'Crypto USDC' : 'Bank SWIFT Wire'}. Ref: ${reference || 'N/A'}.`,
      type: 'payment',
      priority: 'high',
    })

    res.status(200).json({
      success: true,
      message: `Deposit of $${payoutAmount.toFixed(2)} recorded successfully for ${merchant.legalName || merchant.fullName}.`,
      data: payoutRecord,
    })
  } catch (error) {
    next(error)
  }
}


// ----------------------------------------------------------------------
// SUPER ADMIN RESELLER MANAGEMENT ENDPOINTS
// ----------------------------------------------------------------------

// Create / Provision New Reseller Tenant (Super Admin Only)
export async function createResellerTenant(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { name, email, password, merchantFeeRate, payoutTerms } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Reseller company name, login email, and initial password are required.',
      })
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid business email address.',
      })
    }

    // Guard against reserved system emails
    if (
      normalizedEmail === config.superAdmin.email.toLowerCase() ||
      normalizedEmail === config.admin.email.toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        message: 'This email is reserved for system administration.',
      })
    }

    const existingReseller = await ResellerConfig.findOne({ email: normalizedEmail })
    if (existingReseller) {
      return res.status(400).json({
        success: false,
        message: 'A reseller with this email address already exists in the system.',
      })
    }

    // Enforce 9.0% hardwired platform fee floor
    const feeRateNum = parseFloat(merchantFeeRate)
    const finalFeeRate = isNaN(feeRateNum) ? 12.0 : feeRateNum
    if (finalFeeRate < 9.0) {
      return res.status(400).json({
        success: false,
        message: 'Merchant fee rate cannot be set lower than the hardwired 9.0% platform base fee.',
      })
    }

    // Generate unique reseller slug & identifier
    const cleanSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 16)
      .replace(/^_+|_+$/g, '')
    const randomSuffix = Math.floor(1000 + Math.random() * 9000)
    const resellerId = `reseller_${cleanSlug || 'tenant'}_${randomSuffix}`

    // Hash the password securely with bcrypt
    const passwordHash = await bcrypt.hash(password, 10)

    const newReseller = await ResellerConfig.create({
      resellerId,
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      status: 'active',
      feeSettings: {
        basePlatformFee: 9.0,
        merchantFeeRate: finalFeeRate,
      },
      payoutTerms: payoutTerms ? payoutTerms.trim() : 'Weekly Wire / Crypto Transfer',
      createdBy: req.admin?.email || 'super_admin',
    })

    return res.status(201).json({
      success: true,
      message: 'Reseller tenant provisioned successfully.',
      data: {
        resellerId: newReseller.resellerId,
        name: newReseller.name,
        email: newReseller.email,
        feeSettings: newReseller.feeSettings,
        status: newReseller.status,
        payoutTerms: newReseller.payoutTerms,
        createdAt: newReseller.createdAt,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get All Resellers List (Super Admin Only)
export async function getSuperAdminResellersList(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const resellers = await ResellerConfig.find()
      .select('resellerId name email status stripe.mode stripe.isConfigured feeSettings totalVolumeProcessed totalPlatformFeesEarned totalResellerProfit payoutTerms createdAt')
      .sort({ createdAt: -1 })

    const hasRoot = resellers.some((r) => r.resellerId === 'admin_root')
    const result = [...resellers]

    if (!hasRoot) {
      result.unshift({
        resellerId: 'admin_root',
        name: 'Primary Gateway Administrator',
        email: config.admin.email,
        status: 'active',
        stripe: { mode: 'test', isConfigured: false },
        feeSettings: { basePlatformFee: 9.0, merchantFeeRate: 12.0 },
        totalVolumeProcessed: 0,
        totalPlatformFeesEarned: 0,
        totalResellerProfit: 0,
        payoutTerms: 'Default Settlement',
        createdAt: new Date(),
      } as any)
    }

    return res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

// Update Reseller Status (Active / Suspended) (Super Admin Only)
export async function updateResellerStatus(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { resellerId } = req.params
    const { status } = req.body

    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be either 'active' or 'suspended'.",
      })
    }

    if (resellerId === 'admin_root') {
      return res.status(400).json({
        success: false,
        message: 'The root platform reseller account cannot be suspended.',
      })
    }

    const updated = await ResellerConfig.findOneAndUpdate(
      { resellerId },
      { $set: { status } },
      { new: true }
    )

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Reseller not found.',
      })
    }

    return res.status(200).json({
      success: true,
      message: `Reseller ${updated.name || resellerId} status updated to ${status}.`,
      data: {
        resellerId: updated.resellerId,
        status: updated.status,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Reset Reseller Password (Super Admin Only)
export async function resetResellerPassword(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { resellerId } = req.params
    const { newPassword } = req.body

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters in length.',
      })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)

    const updated = await ResellerConfig.findOneAndUpdate(
      { resellerId },
      { $set: { passwordHash } },
      { new: true }
    )

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Reseller not found.',
      })
    }

    return res.status(200).json({
      success: true,
      message: `Password reset successfully for reseller ${updated.name || resellerId}.`,
    })
  } catch (error) {
    next(error)
  }
}


// Update Reseller Fee Structure & Spread (Super Admin Only)
export async function updateResellerFeeStructure(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { resellerId } = req.params
    const { basePlatformFee, merchantFeeRate, payoutTerms } = req.body

    const baseFee = parseFloat(basePlatformFee)
    const merchantRate = parseFloat(merchantFeeRate)

    if (isNaN(baseFee) || baseFee < 0 || baseFee > 50) {
      return res.status(400).json({
        success: false,
        message: 'Super Admin platform fee must be a valid number between 0% and 50%.',
      })
    }

    if (isNaN(merchantRate) || merchantRate < baseFee || merchantRate > 50) {
      return res.status(400).json({
        success: false,
        message: `Merchant fee rate cannot be set lower than the Super Admin platform fee (${baseFee.toFixed(1)}%).`,
      })
    }

    if (resellerId === 'admin_root') {
      let rootConfig = await ResellerConfig.findOne({ resellerId: 'admin_root' })
      if (!rootConfig) {
        rootConfig = await ResellerConfig.create({
          resellerId: 'admin_root',
          name: 'Primary Gateway Administrator',
          email: config.admin.email,
          status: 'active',
          feeSettings: {
            basePlatformFee: baseFee,
            merchantFeeRate: merchantRate,
          },
          payoutTerms: payoutTerms ? payoutTerms.trim() : 'Primary Root Settlement',
        })
      } else {
        rootConfig.feeSettings.basePlatformFee = baseFee
        rootConfig.feeSettings.merchantFeeRate = merchantRate
        if (payoutTerms) rootConfig.payoutTerms = payoutTerms.trim()
        await rootConfig.save()
      }

      return res.status(200).json({
        success: true,
        message: `Fee structure for Primary Root Gateway updated (Platform: ${baseFee.toFixed(1)}%, Merchant: ${merchantRate.toFixed(1)}%).`,
        data: rootConfig,
      })
    }

    const updated = await ResellerConfig.findOneAndUpdate(
      { resellerId },
      {
        $set: {
          'feeSettings.basePlatformFee': baseFee,
          'feeSettings.merchantFeeRate': merchantRate,
          ...(payoutTerms ? { payoutTerms: payoutTerms.trim() } : {}),
        },
      },
      { new: true }
    )

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Reseller tenant not found.',
      })
    }

    const spread = (merchantRate - baseFee).toFixed(1)
    return res.status(200).json({
      success: true,
      message: `Commercial terms updated: Super Admin ${baseFee.toFixed(1)}%, Merchant ${merchantRate.toFixed(1)}% (+${spread}% reseller margin spread).`,
      data: updated,
    })
  } catch (error) {
    next(error)
  }
}

// Reassign Sub-Merchant to another Reseller Tenant (Super Admin Only)
export async function reassignMerchantReseller(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { merchantId } = req.params
    const { targetResellerId } = req.body

    if (!targetResellerId || typeof targetResellerId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid targetResellerId.',
      })
    }

    const cleanResellerId = targetResellerId.trim()

    // Verify reseller exists unless it is 'admin_root'
    if (cleanResellerId !== 'admin_root') {
      const resellerExists = await ResellerConfig.findOne({ resellerId: cleanResellerId })
      if (!resellerExists) {
        return res.status(404).json({
          success: false,
          message: 'Target reseller tenant not found in the system.',
        })
      }
    }

    const updatedMerchant = await Merchant.findByIdAndUpdate(
      merchantId,
      { $set: { resellerId: cleanResellerId } },
      { new: true }
    )

    if (!updatedMerchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found.',
      })
    }

    return res.status(200).json({
      success: true,
      message: `Merchant ${updatedMerchant.fullName} successfully reassigned to tenant ${cleanResellerId}.`,
      data: {
        merchantId: updatedMerchant._id,
        fullName: updatedMerchant.fullName,
        businessEmail: updatedMerchant.businessEmail,
        resellerId: updatedMerchant.resellerId,
      },
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 12. Super Admin: On-Demand Subscription Management
// ----------------------------------------------------
export async function triggerAdminSubscriptionCycle(req: AdminRequest, res: Response, _next: NextFunction) {
  try {
    const report = await triggerManualSubscriptionCycle()
    return res.status(200).json({
      success: true,
      message: `Subscription billing cycle executed. ${report.succeeded} card debits succeeded, ${report.invoiced} crypto invoices generated, ${report.failed} failures.`,
      report,
    })
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      message: error?.message || 'Failed to trigger subscription billing cycle.',
    })
  }
}

export async function chargeMerchantSubscriptionDirect(req: AdminRequest, res: Response, _next: NextFunction) {
  try {
    const merchantId = String(req.params.merchantId)
    const result = await executeMerchantMonthlyCharge(merchantId)
    return res.status(200).json({
      success: result.status !== 'failed',
      message:
        result.status === 'succeeded'
          ? `Successfully auto-debited $${result.amount} via Stripe card on file.`
          : result.status === 'invoiced'
          ? `Successfully issued monthly maintenance invoice for $${result.amount} in BTC.`
          : `Charge failed: ${result.error}`,
      result,
    })
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      message: error?.message || 'Failed to charge merchant subscription.',
    })
  }
}

// ----------------------------------------------------
// 13. Bridge Sharding & Routing Management
// ----------------------------------------------------
export async function updateMerchantBridge(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { assignedBridge } = req.body

    if (!['marketplace', 'leads'].includes(assignedBridge)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid bridge profile. Must be "marketplace" or "leads".',
      })
    }

    const merchant = await Merchant.findById(id)
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant application not found.',
      })
    }

    // Platform Root Security: Resellers (e.g. ARXO) are strictly blocked from changing or viewing bridge profiles
    const isPlatformRoot =
      req.admin?.role === 'super_admin' ||
      req.admin?.resellerId === 'admin_root' ||
      req.admin?.resellerId === 'super_admin_root'

    if (!isPlatformRoot) {
      return res.status(403).json({
        success: false,
        message: 'Access Denied. Bridge routing and Stripe account management is strictly restricted to platform administrators.',
      })
    }

    merchant.assignedBridge = assignedBridge
    await merchant.save()

    res.status(200).json({
      success: true,
      message: `Merchant bridge successfully updated to ${assignedBridge}.`,
      data: {
        merchantId: merchant._id,
        assignedBridge: merchant.assignedBridge,
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function updateResellerDefaultBridge(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { resellerId } = req.params
    const { defaultBridge, applyToExistingMerchants } = req.body

    if (!['marketplace', 'leads'].includes(defaultBridge)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid bridge profile. Must be "marketplace" or "leads".',
      })
    }

    const cleanResellerId = String(resellerId).trim().toUpperCase()
    const resellerConfig = await ResellerConfig.findOne({ resellerId: cleanResellerId })
    if (!resellerConfig) {
      return res.status(404).json({
        success: false,
        message: `Reseller tenant ${cleanResellerId} not found.`,
      })
    }

    resellerConfig.defaultBridge = defaultBridge
    await resellerConfig.save()

    let updatedCount = 0
    if (applyToExistingMerchants) {
      const result = await Merchant.updateMany(
        { resellerId: cleanResellerId },
        { $set: { assignedBridge: defaultBridge } }
      )
      updatedCount = result.modifiedCount
    }

    res.status(200).json({
      success: true,
      message: `Tenant ${cleanResellerId} default bridge updated to ${defaultBridge}.${applyToExistingMerchants ? ` Updated ${updatedCount} existing merchants.` : ''}`,
      data: {
        resellerId: cleanResellerId,
        defaultBridge,
        updatedMerchantsCount: updatedCount,
      },
    })
  } catch (error) {
    next(error)
  }
}
