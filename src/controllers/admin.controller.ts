import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'
import { signToken } from '../utils/jwt.js'
import { Merchant } from '../models/Merchant.js'
import { Notification } from '../models/Notification.js'
import { emitToMerchant, WS_EVENTS } from '../services/socket.service.js'

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

    if (offer && typeof offer === 'object') {
      merchant.offer = {
        rate: offer.rate || merchant.offer?.rate || '2.9% + $0.30',
        volume: offer.volume || merchant.offer?.volume || 'Up to $250,000',
        settlement: offer.settlement || merchant.offer?.settlement || 'Daily (Next Day)',
        reserve: offer.reserve || merchant.offer?.reserve || '5% (90 Days)',
        isAvailable: offer.isAvailable !== undefined ? Boolean(offer.isAvailable) : true,
      }
    }

    await merchant.save()

    // Create In-App Notification for the Merchant
    let notifTitle = 'Application Status Updated'
    let notifContent = notes || `Your merchant application status is now ${status.toUpperCase()}.`

    if (status === 'approved') {
      notifTitle = 'Application Approved! 🎉'
      notifContent =
        notes ||
        `Congratulations! Your merchant account for ${merchant.legalName || merchant.fullName} has been approved. Your custom processing rates are now active.`
    } else if (status === 'rejected') {
      notifTitle = 'Application Update'
      notifContent =
        notes ||
        'Your merchant application could not be approved at this time. Please contact our underwriting desk for assistance.'
    }

    const notification = await Notification.create({
      merchantId: merchant._id,
      title: notifTitle,
      content: notifContent,
      type: status === 'approved' ? 'offer' : 'compliance',
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
