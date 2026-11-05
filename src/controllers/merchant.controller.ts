import { Request, Response, NextFunction } from 'express'
import { Merchant } from '../models/Merchant.js'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { emitToMerchant, WS_EVENTS } from '../services/socket.service.js'
import { uploadBufferToCloudinary } from '../config/cloudinary.js'

// Update Step 2: Business & Processing Information
export async function updateStep2(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.user!._id
    const {
      legalName,
      industry,
      website,
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
        website,
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
