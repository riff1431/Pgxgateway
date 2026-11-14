import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'
import { Merchant } from '../models/Merchant.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Transaction } from '../models/Transaction.js'
import { getNextFormattedId } from '../models/Counter.js'

/**
 * Middleware: Verify Reseller API Key for scoped backend integrations
 */
export function authenticateResellerKey(req: Request, res: Response, next: NextFunction) {
  const apiKey =
    (req.headers['x-reseller-key'] as string) ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '')

  const expectedKey = config.resellerArxo.apiKey.trim()

  if (!apiKey || apiKey.trim() !== expectedKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing reseller API key.',
    })
  }

  next()
}

/**
 * Tier specifications according to ARXO Pay Developer Blueprint (11 Nov 2026, Section 5)
 */
export const ARXO_TIER_TERMS = {
  1: {
    tier: 1,
    name: 'Verified KYB',
    wholesaleFee: 9.0,
    settlementHoldDays: 14,
    rollingReservePercent: 10.0,
    rollingReserveDays: 60,
  },
  2: {
    tier: 2,
    name: 'Documentation Exception',
    wholesaleFee: 12.0,
    settlementHoldDays: 30,
    rollingReservePercent: 20.0,
    rollingReserveDays: 90,
  },
} as const

/**
 * Onboards an ARXO sub-merchant and assigns an immutable sequential ID (ARXO-0001, ARXO-0002...)
 * Endpoint: POST /api/v1/reseller/arxo/onboard
 */
export async function onboardArxoMerchant(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      company,
      contactName,
      firstName,
      lastName,
      email,
      phone,
      website,
      tier = 1,
      assignedRate = 15.0,
      applicationId,
    } = req.body

    if (!company || !email) {
      return res.status(400).json({
        success: false,
        error: 'Company name and business email are required.',
      })
    }

    const normalizedEmail = String(email).toLowerCase().trim()
    const selectedTierNum = Number(tier) === 2 ? 2 : 1
    const tierConfig = ARXO_TIER_TERMS[selectedTierNum]
    const numericRate = Math.max(tierConfig.wholesaleFee, Number(assignedRate) || 15.0)
    const arxoMarkup = Math.max(0, Number((numericRate - tierConfig.wholesaleFee).toFixed(2)))
    const resolvedContact = (contactName || `${firstName || ''} ${lastName || ''}`).trim() || company

    // Ensure ARXO ResellerConfig exists in Master Ledger
    await ResellerConfig.findOneAndUpdate(
      { resellerId: 'ARXO' },
      {
        $setOnInsert: {
          resellerId: 'ARXO',
          name: 'ARXO Pay Reseller Desk',
          email: 'admin@arxopay.com',
          status: 'active',
          'feeSettings.basePlatformFee': 9.0,
          'feeSettings.merchantFeeRate': 15.0,
        },
      },
      { upsert: true, new: true }
    )

    // Check if sub-merchant is already synced
    let merchant = await Merchant.findOne({
      $or: [
        { businessEmail: normalizedEmail },
        ...(applicationId ? [{ 'offer.externalApplicationId': applicationId }] : []),
      ],
    })

    if (merchant) {
      // Update terms if existing
      merchant.offer = {
        ...(merchant.offer || {}),
        rate: `${numericRate}%`,
        volume: 'Standard ARXO Volume',
        settlement: `${tierConfig.settlementHoldDays} Days`,
        reserve: `${tierConfig.rollingReservePercent}% for ${tierConfig.rollingReserveDays} Days`,
        tier: selectedTierNum,
        externalApplicationId: applicationId || merchant.offer?.externalApplicationId,
        isAvailable: true,
        accepted: true,
        acceptedAt: new Date(),
      }
      if (merchant.applicationStatus !== 'approved') {
        merchant.applicationStatus = 'approved'
      }
      await merchant.save()

      return res.status(200).json({
        success: true,
        message: 'Merchant record updated with ARXO terms.',
        refId: merchant.refId,
        merchantId: merchant._id,
        resellerId: 'ARXO',
        tier: selectedTierNum,
        pricing: {
          assignedRate: numericRate,
          pgxWholesaleFee: tierConfig.wholesaleFee,
          arxoMarkup,
          settlementHoldDays: tierConfig.settlementHoldDays,
          rollingReservePercent: tierConfig.rollingReservePercent,
          rollingReserveDays: tierConfig.rollingReserveDays,
        },
      })
    }

    // Atomically generate immutable ID (e.g. ARXO-0001)
    const generatedRefId = await getNextFormattedId('ARXO', 4)

    merchant = await Merchant.create({
      refId: generatedRefId,
      resellerId: 'ARXO',
      legalName: String(company).trim(),
      fullName: resolvedContact,
      businessEmail: normalizedEmail,
      phone: phone ? String(phone).trim() : '+1-000-000-0000',
      website: website ? String(website).trim() : '',
      role: 'sub_merchant',
      applicationStatus: 'approved',
      currentStep: 3,
      agreedToTerms: true,
      offer: {
        rate: `${numericRate}%`,
        volume: 'Standard ARXO Processing',
        settlement: `${tierConfig.settlementHoldDays} Days`,
        reserve: `${tierConfig.rollingReservePercent}% for ${tierConfig.rollingReserveDays} Days`,
        setupFee: '$0',
        monthlyFee: '$0',
        tier: selectedTierNum,
        externalApplicationId: applicationId || '',
        isAvailable: true,
        accepted: true,
        acceptedAt: new Date(),
      },
    })

    return res.status(201).json({
      success: true,
      message: 'Sub-merchant successfully onboarded to PGX Master Ledger.',
      refId: merchant.refId,
      merchantId: merchant._id,
      resellerId: 'ARXO',
      tier: selectedTierNum,
      pricing: {
        assignedRate: numericRate,
        pgxWholesaleFee: tierConfig.wholesaleFee,
        arxoMarkup,
        settlementHoldDays: tierConfig.settlementHoldDays,
        rollingReservePercent: tierConfig.rollingReservePercent,
        rollingReserveDays: tierConfig.rollingReserveDays,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Scoped Ledger Overview for ARXO Pay Admin Site
 * Endpoint: GET /api/v1/reseller/arxo/overview
 */
export async function getArxoOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const resellerDoc = await ResellerConfig.findOne({ resellerId: 'ARXO' })
    const merchants = await Merchant.find({ resellerId: 'ARXO' })
      .select('refId legalName fullName businessEmail offer balance createdAt applicationStatus')
      .sort({ createdAt: -1 })

    const totalGrossVolume = merchants.reduce((acc, m) => acc + (m.balance?.grossVolume || 0), 0)
    const totalMerchantNet = merchants.reduce((acc, m) => acc + (m.balance?.netBalance || 0), 0)

    // Recent ARXO transactions
    const transactions = await Transaction.find({ resellerId: 'ARXO' })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('transactionId merchantRefId grossAmount platformFeeAmount resellerProfitAmount merchantNetAmount currency status createdAt')

    return res.status(200).json({
      success: true,
      resellerId: 'ARXO',
      totals: {
        totalMerchants: merchants.length,
        totalVolumeProcessed: resellerDoc?.totalVolumeProcessed || totalGrossVolume,
        totalPlatformFeesEarned: resellerDoc?.totalPlatformFeesEarned || 0,
        totalResellerProfit: resellerDoc?.totalResellerProfit || 0,
        totalMerchantNet,
      },
      merchants: merchants.map((m) => ({
        id: m._id,
        refId: m.refId,
        legalName: m.legalName,
        email: m.businessEmail,
        tier: m.offer?.tier || 1,
        rate: m.offer?.rate || '15%',
        settlement: m.offer?.settlement || '14 Days',
        reserve: m.offer?.reserve || '10%',
        grossVolume: m.balance?.grossVolume || 0,
        netBalance: m.balance?.netBalance || 0,
        status: m.applicationStatus,
        createdAt: m.createdAt,
      })),
      recentTransactions: transactions,
    })
  } catch (error) {
    next(error)
  }
}
