import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { Merchant } from '../models/Merchant.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Notification } from '../models/Notification.js'
import { signToken } from '../utils/jwt.js'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { sendPasswordResetEmail, sendWelcomeEmail } from '../services/email.service.js'

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      fullName,
      businessEmail,
      phone,
      whatsapp,
      telegram,
      password,
      resellerId,
      websiteDomain,
      gitRepoUrl,
    } = req.body

    if (!fullName || !businessEmail || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide full name, business email, phone number, and password.',
      })
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long.',
      })
    }

    const normalizedEmail = businessEmail.toLowerCase().trim();

    // Check if email already registered
    const existingMerchant = await Merchant.findOne({ businessEmail: normalizedEmail })
    if (existingMerchant) {
      return res.status(409).json({
        success: false,
        message: 'A merchant account with this email address already exists. Please sign in.',
      })
    }

    const assignedResellerId =
      resellerId && typeof resellerId === 'string' && resellerId.trim()
        ? resellerId.trim()
        : 'admin_root'

    // Create merchant record (Step 1 complete)
    const merchant = await Merchant.create({
      fullName: fullName.trim(),
      businessEmail: normalizedEmail,
      phone: phone.trim(),
      whatsapp: whatsapp?.trim(),
      telegram: telegram?.trim(),
      password,
      resellerId: assignedResellerId,
      websiteDomain: websiteDomain?.trim() || '',
      website: websiteDomain?.trim() || '',
      gitRepoUrl: gitRepoUrl?.trim() || '',
      setupStatus: 'pending_payment',
      currentStep: 1,
      applicationStatus: 'draft',
      offer: {
        rate: '',
        volume: '',
        settlement: '',
        reserve: '',
        setupFee: '',
        monthlyFee: '',
        isAvailable: false,
        accepted: false,
      },
    })

    // Seed default notifications matching the frontend "Messages (2)" badge
    await Notification.create([
      {
        merchantId: merchant._id,
        title: 'Welcome to PGX Gateway',
        content: 'Your merchant account has been initiated. Proceed with business & document verification.',
        type: 'system',
      },
      {
        merchantId: merchant._id,
        title: 'Underwriting Review',
        content: 'Your account is in queue. Please check back every 24hrs to see if offer is available and accept to proceed.',
        type: 'system',
      },
    ])

    // Generate JWT token
    const token = signToken({
      id: String(merchant._id),
      email: merchant.businessEmail,
    })

    // Send welcome notification email asynchronously (do not block registration)
    sendWelcomeEmail(merchant.businessEmail, merchant.fullName, merchant.refId || 'PGX-PENDING').catch(err => {
      console.warn('[Auth] Welcome email delivery failed:', err?.message || err)
    })

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Step 1 completed.',
      token,
      data: {
        id: merchant._id,
        fullName: merchant.fullName,
        businessEmail: merchant.businessEmail,
        phone: merchant.phone,
        whatsapp: merchant.whatsapp,
        telegram: merchant.telegram,
        currentStep: merchant.currentStep,
        applicationStatus: merchant.applicationStatus,
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const rawEmail = req.body.businessEmail || req.body.email;
    const { password } = req.body;

    if (!rawEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide business email and password.',
      })
    }

    const normalizedEmail = String(rawEmail).toLowerCase().trim();

    // Find merchant including the password field
    const merchant = await Merchant.findOne({ businessEmail: normalizedEmail }).select('+password')

    if (!merchant || !merchant.password) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      })
    }

    // Compare password hash
    const isMatch = await merchant.comparePassword(password)
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      })
    }

    // Generate JWT token
    const token = signToken({
      id: String(merchant._id),
      email: merchant.businessEmail,
    })

    res.status(200).json({
      success: true,
      message: 'Logged in successfully.',
      token,
      data: {
        id: merchant._id,
        _id: merchant._id,
        fullName: merchant.fullName,
        businessEmail: merchant.businessEmail,
        phone: merchant.phone,
        avatarUrl: merchant.avatarUrl || '',
        currentStep: merchant.currentStep,
        applicationStatus: merchant.applicationStatus,
        refId: merchant.refId,
        apiKey: merchant.apiKey,
        accountMode: merchant.accountMode,
        trial: merchant.trial,
        resellerId: merchant.resellerId,
        offer: merchant.offer,
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function getMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.user!

    // Count unread notifications
    const unreadCount = await Notification.countDocuments({
      merchantId: merchant._id,
      isRead: false,
    })

    res.status(200).json({
      success: true,
      data: {
        id: merchant._id,
        fullName: merchant.fullName,
        businessEmail: merchant.businessEmail,
        phone: merchant.phone,
        whatsapp: merchant.whatsapp,
        telegram: merchant.telegram,
        avatarUrl: merchant.avatarUrl || '',
        legalName: merchant.legalName,
        industry: merchant.industry,
        website: merchant.website,
        yearsInBusiness: merchant.yearsInBusiness,
        currentProcessor: merchant.currentProcessor,
        monthlyVolume: merchant.monthlyVolume,
        avgTransaction: merchant.avgTransaction,
        chargebackRate: merchant.chargebackRate,
        switchReason: merchant.switchReason,
        businessRegDoc: merchant.businessRegDoc,
        directorIdDoc: merchant.directorIdDoc,
        processingStatementDoc: merchant.processingStatementDoc,
        agreedToTerms: merchant.agreedToTerms,
        currentStep: merchant.currentStep,
        applicationStatus: merchant.applicationStatus,
        refId: merchant.refId,
        apiKey: merchant.apiKey,
        accountMode: merchant.accountMode,
        trial: merchant.trial,
        resellerId: merchant.resellerId,
        offer: merchant.offer,
        unreadNotifications: unreadCount,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Update Profile Information (Account Settings)
export async function updateProfile(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const { fullName, phone, whatsapp, telegram, avatarUrl } = req.body

    const updateFields: Record<string, string> = {}
    if (fullName) updateFields.fullName = fullName.trim()
    if (phone) updateFields.phone = phone.trim()
    if (whatsapp !== undefined) updateFields.whatsapp = whatsapp.trim()
    if (telegram !== undefined) updateFields.telegram = telegram.trim()
    if (avatarUrl !== undefined) updateFields.avatarUrl = avatarUrl.trim()

    const updated = await Merchant.findByIdAndUpdate(merchantId, updateFields, {
      new: true,
      runValidators: true,
    })

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully.',
      data: updated,
    })
  } catch (error) {
    next(error)
  }
}

// Change Password (Account Settings Security)
export async function changePassword(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both current and new passwords.',
      })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long.',
      })
    }

    // Fetch merchant including password
    const merchant = await Merchant.findById(merchantId).select('+password')
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant account not found.',
      })
    }

    const isMatch = await merchant.comparePassword(currentPassword)
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect.',
      })
    }

    merchant.password = newPassword
    await merchant.save()

    res.status(200).json({
      success: true,
      message: 'Password changed successfully.',
    })
  } catch (error) {
    next(error)
  }
}

// Request Password Reset Link (Forgot Password)
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an email address.',
      })
    }

    const normalizedEmail = String(email).toLowerCase().trim()
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expires = new Date(Date.now() + 60 * 60 * 1000) // 1 hour validity

    let userFound = false
    let recipientName: string | undefined

    // 1. Check in Merchant accounts
    const merchant = await Merchant.findOne({ businessEmail: normalizedEmail })
    if (merchant) {
      merchant.resetPasswordToken = tokenHash
      merchant.resetPasswordExpires = expires
      await merchant.save()
      userFound = true
      recipientName = merchant.fullName
    } else {
      // 2. Check in Reseller accounts
      const reseller = await ResellerConfig.findOne({ email: normalizedEmail })
      if (reseller) {
        reseller.resetPasswordToken = tokenHash
        reseller.resetPasswordExpires = expires
        await reseller.save()
        userFound = true
        recipientName = reseller.name
      }
    }

    if (userFound) {
      const origin = req.headers.origin || 'https://pgxgateway.com'
      const resetUrl = `${origin}/register?mode=reset&token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`
      await sendPasswordResetEmail(normalizedEmail, resetUrl, recipientName)
    }

    // Always respond with success to prevent account enumeration
    res.status(200).json({
      success: true,
      message: 'If an account exists with this email address, a password reset link has been dispatched.',
    })
  } catch (error) {
    next(error)
  }
}

// Complete Password Reset
export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, email, password } = req.body

    if (!token || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Token, email, and new password are required.',
      })
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long.',
      })
    }

    const normalizedEmail = String(email).toLowerCase().trim()
    const tokenHash = crypto.createHash('sha256').update(String(token).trim()).digest('hex')

    // 1. Try finding in Merchant
    const merchant = await Merchant.findOne({
      businessEmail: normalizedEmail,
      resetPasswordToken: tokenHash,
      resetPasswordExpires: { $gt: new Date() },
    }).select('+password +resetPasswordToken +resetPasswordExpires')

    if (merchant) {
      merchant.password = password
      merchant.resetPasswordToken = undefined
      merchant.resetPasswordExpires = undefined
      await merchant.save()

      return res.status(200).json({
        success: true,
        message: 'Password reset successfully. You can now sign in with your new password.',
      })
    }

    // 2. Try finding in ResellerConfig
    const reseller = await ResellerConfig.findOne({
      email: normalizedEmail,
      resetPasswordToken: tokenHash,
      resetPasswordExpires: { $gt: new Date() },
    }).select('+passwordHash +resetPasswordToken +resetPasswordExpires')

    if (reseller) {
      const salt = await bcrypt.genSalt(10)
      reseller.passwordHash = await bcrypt.hash(password, salt)
      reseller.resetPasswordToken = undefined
      reseller.resetPasswordExpires = undefined
      await reseller.save()

      return res.status(200).json({
        success: true,
        message: 'Password reset successfully. You can now sign in with your new password.',
      })
    }

    return res.status(400).json({
      success: false,
      message: 'Invalid or expired password reset link. Please request a new one.',
    })
  } catch (error) {
    next(error)
  }
}
