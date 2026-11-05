import { Request, Response, NextFunction } from 'express'
import { Merchant } from '../models/Merchant.js'

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
      businessRegDoc,
      directorIdDoc,
      processingStatementDoc,
      agreedToTerms,
      currentStep = 3,
    } = req.body

    if (!businessEmail) {
      return res.status(400).json({
        success: false,
        message: 'Business email is required.',
      })
    }

    // Upsert merchant record by businessEmail
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
        ...(businessRegDoc && { businessRegDoc }),
        ...(directorIdDoc && { directorIdDoc }),
        ...(processingStatementDoc && { processingStatementDoc }),
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

export async function getLatestApplication(_req: Request, res: Response, next: NextFunction) {
  try {
    // Return latest application or a sample mock for dashboard initialization
    const latest = await Merchant.findOne().sort({ createdAt: -1 })

    if (!latest) {
      return res.status(200).json({
        success: true,
        data: {
          fullName: 'Merchant',
          applicationStatus: 'under_review',
          currentStep: 3,
          offer: {
            rate: '2.9% + $0.30',
            volume: 'Up to $250,000',
            settlement: 'Daily (Next Day)',
            reserve: '5% (90 Days)',
            isAvailable: true,
          },
        },
      })
    }

    res.status(200).json({
      success: true,
      data: latest,
    })
  } catch (error) {
    next(error)
  }
}
