import { Request, Response, NextFunction } from 'express'
import { Merchant } from '../models/Merchant.js'
import { Notification } from '../models/Notification.js'
import { Transaction } from '../models/Transaction.js'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { emitToMerchant, emitToAdmins, WS_EVENTS } from '../services/socket.service.js'
import { uploadBufferToCloudinary } from '../config/cloudinary.js'

// Update Step 2: Business & Processing Information
export async function updateStep2(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const {
      legalName,
      industry,
      website,
      websiteDomain,
      gitRepoUrl,
      yearsInBusiness,
      currentProcessor,
      monthlyVolume,
      avgTransaction,
      chargebackRate,
      switchReason,
    } = req.body

    const updated = await Merchant.findByIdAndUpdate(
      merchantId,
      {
        legalName,
        industry,
        website: (websiteDomain || website || '').trim(),
        websiteDomain: (websiteDomain || website || '').trim(),
        gitRepoUrl: gitRepoUrl?.trim(),
        yearsInBusiness,
        currentProcessor,
        monthlyVolume,
        avgTransaction,
        chargebackRate,
        switchReason,
        currentStep: 2,
      },
      { new: true, runValidators: true }
    )

    res.status(200).json({
      success: true,
      message: 'Business information updated successfully. Step 2 completed.',
      data: updated,
    })
  } catch (error) {
    next(error)
  }
}

// Upload Step 3 Documents (Directly stream to Cloudinary)
export async function uploadStep3Documents(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const files = req.files as { [fieldname: string]: Express.Multer.File[] }

    const updateFields: Record<string, unknown> = {
      currentStep: 3,
    }

    if (files?.businessRegDoc?.[0]) {
      const file = files.businessRegDoc[0]
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
      const cloudRes = await uploadBufferToCloudinary(file.buffer, file.originalname, 'pgxgateway/business_registration')

      updateFields.businessRegDoc = {
        name: file.originalname,
        url: cloudRes.url,
        path: cloudRes.publicId,
        size: `${sizeMB} MB`,
        uploadedAt: new Date(),
      }
    }

    if (files?.directorIdDoc?.[0]) {
      const file = files.directorIdDoc[0]
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
      const cloudRes = await uploadBufferToCloudinary(file.buffer, file.originalname, 'pgxgateway/director_id')

      updateFields.directorIdDoc = {
        name: file.originalname,
        url: cloudRes.url,
        path: cloudRes.publicId,
        size: `${sizeMB} MB`,
        uploadedAt: new Date(),
      }
    }

    if (files?.processingStatementDoc?.[0]) {
      const file = files.processingStatementDoc[0]
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1)
      const cloudRes = await uploadBufferToCloudinary(file.buffer, file.originalname, 'pgxgateway/processing_statements')

      updateFields.processingStatementDoc = {
        name: file.originalname,
        url: cloudRes.url,
        path: cloudRes.publicId,
        size: `${sizeMB} MB`,
        uploadedAt: new Date(),
      }
    }

    const updated = await Merchant.findByIdAndUpdate(merchantId, updateFields, {
      new: true,
    })

    res.status(200).json({
      success: true,
      message: 'Documents uploaded to Cloudinary successfully.',
      data: {
        businessRegDoc: updated?.businessRegDoc,
        directorIdDoc: updated?.directorIdDoc,
        processingStatementDoc: updated?.processingStatementDoc,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Final Submit Application (Consent confirmation & Under Review)
export async function submitApplication(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const { agreedToTerms } = req.body

    if (!agreedToTerms) {
      return res.status(400).json({
        success: false,
        message: 'You must confirm the information accuracy and accept the Terms of Service.',
      })
    }

    const updated = await Merchant.findByIdAndUpdate(
      merchantId,
      {
        agreedToTerms: true,
        currentStep: 3,
        applicationStatus: 'under_review',
      },
      { new: true }
    )

    // Emit real-time WebSocket update to the merchant's private room
    emitToMerchant(String(merchantId), WS_EVENTS.APPLICATION_UPDATED, {
      applicationStatus: updated?.applicationStatus,
      currentStep: updated?.currentStep,
      offer: updated?.offer,
      timestamp: new Date().toISOString(),
    })

    res.status(200).json({
      success: true,
      message: 'Application submitted successfully. It is now under review.',
      data: {
        applicationStatus: updated?.applicationStatus,
        currentStep: updated?.currentStep,
        offer: updated?.offer,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get Application Status (Powers the Dashboard Status Card)
export async function getApplicationStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.user!

    res.status(200).json({
      success: true,
      data: {
        status: merchant.applicationStatus, // 'under_review' | 'approved' | etc.
        currentStep: merchant.currentStep,
        steps: [
          {
            step: 1,
            title: 'Account & Contact',
            isCompleted: true,
          },
          {
            step: 2,
            title: 'Business & Processing',
            isCompleted: Boolean(merchant.legalName && merchant.industry),
          },
          {
            step: 3,
            title: 'Verification & Documents',
            isCompleted: merchant.agreedToTerms,
            isActive: merchant.applicationStatus === 'under_review',
          },
        ],
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get Processing Offer (Powers the Dashboard Offer Card)
export async function getProcessingOffer(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.user!

    res.status(200).json({
      success: true,
      data: merchant.offer || {
        rate: '',
        volume: '',
        settlement: '',
        reserve: '',
        isAvailable: false,
        accepted: false,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Accept Processing Offer
export async function acceptProcessingOffer(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const merchant = await Merchant.findById(merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    if (!merchant.offer?.isAvailable) {
      return res.status(400).json({
        success: false,
        message: 'No processing offer is available to accept yet. Please check back every 24hrs.',
      })
    }

    merchant.offer.accepted = true
    merchant.offer.acceptedAt = new Date()
    await merchant.save()

    // Notification
    const notif = await Notification.create({
      merchantId: merchant._id,
      senderRole: 'system',
      senderName: 'PGX Underwriting Team',
      title: 'Processing Agreement Confirmed 🎉',
      content: `Your acceptance of the processing terms (${merchant.offer.rate}, ${merchant.offer.volume}) has been recorded. Commercial schedule is locked in.`,
      type: 'offer',
      priority: 'high',
      labels: ['Offer Accepted', 'Terms Confirmed'],
      isRead: false,
    })

    const unreadCount = await Notification.countDocuments({
      merchantId: merchant._id,
      isRead: false,
    })

    emitToMerchant(String(merchant._id), WS_EVENTS.OFFER_UPDATED, {
      offer: merchant.offer,
      timestamp: new Date().toISOString(),
    })
    emitToMerchant(String(merchant._id), WS_EVENTS.NEW_NOTIFICATION, {
      notification: notif,
      unreadCount,
    })

    res.status(200).json({
      success: true,
      message: 'Processing offer accepted successfully.',
      data: merchant.offer,
    })
  } catch (error) {
    next(error)
  }
}

// Upload or Set Merchant Avatar
export async function uploadAvatar(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    let avatarUrl = ''

    if (req.file) {
      const file = req.file
      const cloudRes = await uploadBufferToCloudinary(
        file.buffer,
        file.originalname,
        'pgxgateway/avatars'
      )
      avatarUrl = cloudRes.url
    } else if (req.body.avatarUrl !== undefined) {
      avatarUrl = String(req.body.avatarUrl).trim()
    } else {
      return res.status(400).json({
        success: false,
        message: 'No avatar file or URL provided.',
      })
    }

    const updated = await Merchant.findByIdAndUpdate(
      merchantId,
      { avatarUrl },
      { new: true }
    )

    emitToMerchant(String(merchantId), WS_EVENTS.APPLICATION_UPDATED, {
      applicationStatus: updated?.applicationStatus,
      currentStep: updated?.currentStep,
      offer: updated?.offer,
      avatarUrl: updated?.avatarUrl,
      timestamp: new Date().toISOString(),
    })

    res.status(200).json({
      success: true,
      message: 'Avatar updated successfully.',
      data: updated,
      avatarUrl: updated?.avatarUrl,
    })
  } catch (error) {
    next(error)
  }
}

// Backward-compatible public registration for unauthenticated one-shot submissions
export async function submitRegistration(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      fullName,
      businessEmail,
      phone,
      whatsapp,
      telegram,
      password,
      legalName,
      industry,
      website,
      yearsInBusiness,
      currentProcessor,
      monthlyVolume,
      avgTransaction,
      chargebackRate,
      switchReason,
      agreedToTerms,
      currentStep = 3,
    } = req.body

    if (!businessEmail) {
      return res.status(400).json({
        success: false,
        message: 'Business email is required.',
      })
    }

    const merchant = await Merchant.findOneAndUpdate(
      { businessEmail: businessEmail.toLowerCase().trim() },
      {
        fullName,
        businessEmail: businessEmail.toLowerCase().trim(),
        phone,
        whatsapp,
        telegram,
        ...(password && { password }),
        legalName,
        industry,
        website,
        yearsInBusiness,
        currentProcessor,
        monthlyVolume,
        avgTransaction,
        chargebackRate,
        switchReason,
        agreedToTerms: Boolean(agreedToTerms),
        currentStep,
        applicationStatus: 'under_review',
      },
      { new: true, upsert: true, runValidators: true }
    )

    res.status(201).json({
      success: true,
      message: 'Merchant application submitted successfully.',
      data: merchant,
    })
  } catch (error) {
    next(error)
  }
}

export async function getMerchantByEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const email = String(req.params.email).toLowerCase().trim()

    const merchant = await Merchant.findOne({ businessEmail: email })
    if (!merchant) {
      return res.status(404).json({
        success: false,
        message: 'Merchant not found.',
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

export async function getMerchantTransactions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user?._id
    if (!merchantId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' })
    }

    const merchant = await Merchant.findById(merchantId).select(
      'refId legalName fullName payoutSettings payoutHistory balance'
    )
    if (!merchant || !merchant.refId) {
      return res.status(404).json({ success: false, message: 'Merchant reference not found.' })
    }

    const now = new Date()

    // 1. Auto-mature 14-day (or 45-day) settlement holds if eligible date has passed
    await Transaction.updateMany(
      {
        merchantRefId: merchant.refId,
        status: 'succeeded',
        settlementStatus: 'on_hold',
        settlementEligibleAt: { $lte: now },
      },
      {
        $set: { settlementStatus: 'available' },
      }
    )

    // 2. Auto-release matured rolling reserves if reserve release date has passed
    const maturedReserves = await Transaction.find({
      merchantRefId: merchant.refId,
      status: 'succeeded',
      rollingReserveStatus: 'locked',
      rollingReserveReleaseAt: { $lte: now },
    })

    if (maturedReserves.length > 0) {
      for (const txn of maturedReserves) {
        txn.rollingReserveStatus = 'released'
        await txn.save()
      }
    }

    const transactions = await Transaction.find({ merchantRefId: merchant.refId })
      .sort({ createdAt: -1 })
      .limit(100)

    let totalGross = 0
    let totalNet = 0
    let onHoldBalance = 0
    let availableBalance = 0
    let rollingReserveBalance = 0

    transactions.forEach((t) => {
      if (t.status === 'succeeded') {
        const gross = t.grossAmount || 0
        const fee = t.resellerFeeAmount || t.platformFeeAmount || 0
        const reserve = t.rollingReserveAmount || 0
        // Net settlement held for 14-day maturity (gross minus processing fee minus rolling reserve)
        const netSettlement = Math.max(0, gross - fee - reserve)

        totalGross += gross
        totalNet += t.merchantNetAmount || Math.max(0, gross - fee)

        if (t.settlementStatus === 'on_hold') {
          onHoldBalance += netSettlement
        } else if (t.settlementStatus === 'available') {
          availableBalance += netSettlement
        }

        if (t.rollingReserveStatus === 'locked') {
          rollingReserveBalance += reserve
        } else if (t.rollingReserveStatus === 'released' && t.settlementStatus !== 'paid_out') {
          // Once released from reserve escrow, it enters available payout balance if not already disbursed
          availableBalance += reserve
        }
      }
    })

    // Calculate total completed daily deposits/payouts sent to merchant
    const totalDeposited = (merchant.payoutHistory || []).reduce(
      (sum, p) => sum + (p.status === 'completed' ? p.amount || 0 : 0),
      0
    )

    // Deduct already disbursed amounts from available balance so it stays accurate
    const netAvailable = Math.max(0, availableBalance - totalDeposited)

    return res.status(200).json({
      success: true,
      data: transactions,
      payoutHistory: (merchant.payoutHistory || []).sort(
        (a, b) => new Date(b.depositedAt).getTime() - new Date(a.depositedAt).getTime()
      ),
      payoutSettings: merchant.payoutSettings || {},
      metrics: {
        totalGross: parseFloat(totalGross.toFixed(2)),
        totalNet: parseFloat(totalNet.toFixed(2)),
        onHoldBalance: parseFloat(onHoldBalance.toFixed(2)),
        availableBalance: parseFloat(netAvailable.toFixed(2)),
        rollingReserveBalance: parseFloat(rollingReserveBalance.toFixed(2)),
        totalDeposited: parseFloat(totalDeposited.toFixed(2)),
        totalCount: transactions.length,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Update Merchant Payout & Settlement Receiving Destination
export async function updatePayoutSettings(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user?._id
    if (!merchantId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' })
    }

    const { preferredMethod, cryptoUsdc, bankSwift } = req.body

    const merchant = await Merchant.findById(merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    merchant.payoutSettings = {
      preferredMethod: preferredMethod === 'bank_swift' ? 'bank_swift' : 'crypto_usdc',
      cryptoUsdc: {
        address: cryptoUsdc?.address ? String(cryptoUsdc.address).trim() : '',
        network: cryptoUsdc?.network ? String(cryptoUsdc.network).trim() : 'ERC-20',
      },
      bankSwift: {
        beneficiaryName: bankSwift?.beneficiaryName ? String(bankSwift.beneficiaryName).trim() : '',
        bankName: bankSwift?.bankName ? String(bankSwift.bankName).trim() : '',
        swiftBic: bankSwift?.swiftBic ? String(bankSwift.swiftBic).trim().toUpperCase() : '',
        ibanOrAccountNumber: bankSwift?.ibanOrAccountNumber
          ? String(bankSwift.ibanOrAccountNumber).trim()
          : '',
        bankCountry: bankSwift?.bankCountry ? String(bankSwift.bankCountry).trim() : '',
        routingNumber: bankSwift?.routingNumber ? String(bankSwift.routingNumber).trim() : '',
        bankAddress: bankSwift?.bankAddress ? String(bankSwift.bankAddress).trim() : '',
      },
      updatedAt: new Date(),
    }

    await merchant.save()

    return res.status(200).json({
      success: true,
      message: 'Payout destination settings saved successfully.',
      data: merchant.payoutSettings,
    })
  } catch (error) {
    next(error)
  }
}

// Submit 30-Day Monthly Maintenance Payment (Crypto TxID + Screenshot Upload)
export async function submitMonthlyMaintenancePayment(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user?._id
    if (!merchantId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' })
    }

    const merchant = await Merchant.findById(merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found.' })
    }

    const { txHash, currency, network, notes } = req.body
    let screenshotUrl = ''
    let screenshotName = ''

    if (req.file) {
      try {
        const cloudRes = await uploadBufferToCloudinary(
          req.file.buffer,
          req.file.originalname,
          'pgxgateway/monthly_maintenance_proofs'
        )
        screenshotUrl = cloudRes.url
        screenshotName = req.file.originalname
      } catch {
        // Safe fallback to data-uri if Cloudinary keys are unset in local environment
        screenshotUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
        screenshotName = req.file.originalname
      }
    }

    if (!merchant.arxopayWholesale) {
      merchant.arxopayWholesale = {}
    }

    merchant.arxopayWholesale.monthlyMaintenance = {
      amount: 499,
      currency: currency || 'USDT',
      network: network || 'TRC-20',
      txHash: txHash ? String(txHash).trim() : '',
      screenshotUrl,
      screenshotName,
      lastPaidAt: new Date(),
      status: 'pending_verification',
    }

    await merchant.save()

    emitToAdmins(WS_EVENTS.NEW_NOTIFICATION, {
      title: 'Monthly Maintenance Payment Submitted',
      message: `Merchant ${merchant.legalName || merchant.fullName} submitted $499 monthly maintenance payment (${currency || 'USDT'}). TxID: ${txHash || 'N/A'}.`,
      type: 'payment',
      priority: 'high',
    })

    return res.status(200).json({
      success: true,
      message: 'Monthly maintenance payment proof submitted successfully. Underwriting desk review in progress.',
      data: merchant.arxopayWholesale.monthlyMaintenance,
    })
  } catch (error) {
    next(error)
  }
}
