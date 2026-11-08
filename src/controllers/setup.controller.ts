import { Request, Response, NextFunction } from 'express'
import { SystemConfig, ISystemConfig } from '../models/SystemConfig.js'
import { Merchant } from '../models/Merchant.js'
import { SetupMessage } from '../models/SetupMessage.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Notification } from '../models/Notification.js'
import { createStripeCheckoutSession } from '../services/stripe.service.js'
import { emitToAdmins, emitToMerchant, WS_EVENTS } from '../services/socket.service.js'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { AdminRequest } from '../middleware/admin.middleware.js'

async function getOrCreateSystemConfig(): Promise<ISystemConfig> {
  let config = await SystemConfig.findOne()
  if (!config) {
    config = await SystemConfig.create({
      siteName: 'PGX Gateway',
      setupFeePriceUSD: 450.0,
      setupFeePresetAltUSD: 565.0,
      officialGithubHandle: 'huipper-dev',
      affiliateCommissionRate: 20.0,
      stripe: {
        publishableKey: '',
        secretKey: '',
        webhookSecret: '',
        isConfigured: false,
        mode: 'test',
      },
    })
  }
  return config
}

// ----------------------------------------------------
// 1. SUPER ADMIN: Platform Settings
// ----------------------------------------------------
export async function getPlatformSettings(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const config = await getOrCreateSystemConfig()

    const maskedSecretKey = config.stripe?.secretKey
      ? `${config.stripe.secretKey.slice(0, 7)}...${config.stripe.secretKey.slice(-4)}`
      : ''

    return res.status(200).json({
      success: true,
      settings: {
        siteName: config.siteName,
        logoUrl: config.logoUrl,
        faviconUrl: config.faviconUrl,
        supportEmail: config.supportEmail,
        supportPhone: config.supportPhone,
        supportTelegram: config.supportTelegram,
        supportWhatsapp: config.supportWhatsapp,
        setupFeePriceUSD: config.setupFeePriceUSD ?? 450.0,
        setupFeePresetAltUSD: config.setupFeePresetAltUSD ?? 565.0,
        officialGithubHandle: config.officialGithubHandle || 'huipper-dev',
        affiliateCommissionRate: config.affiliateCommissionRate ?? 20.0,
        stripe: {
          publishableKey: config.stripe?.publishableKey || '',
          secretKey: maskedSecretKey,
          hasSecretKey: Boolean(config.stripe?.secretKey),
          webhookSecret: config.stripe?.webhookSecret ? '••••••••' : '',
          isConfigured: Boolean(config.stripe?.isConfigured),
          mode: config.stripe?.mode || 'test',
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function updatePlatformSettings(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const {
      siteName,
      setupFeePriceUSD,
      officialGithubHandle,
      affiliateCommissionRate,
      stripe,
      supportEmail,
      supportPhone,
      supportTelegram,
      supportWhatsapp,
    } = req.body

    const config = await getOrCreateSystemConfig()

    if (siteName !== undefined) config.siteName = siteName.trim()
    if (setupFeePriceUSD !== undefined) config.setupFeePriceUSD = Math.max(0, Number(setupFeePriceUSD))
    if (req.body.setupFeePresetAltUSD !== undefined) config.setupFeePresetAltUSD = Math.max(0, Number(req.body.setupFeePresetAltUSD))
    if (officialGithubHandle !== undefined) config.officialGithubHandle = officialGithubHandle.trim().replace(/^@/, '')
    if (affiliateCommissionRate !== undefined) config.affiliateCommissionRate = Math.min(100, Math.max(0, Number(affiliateCommissionRate)))
    if (supportEmail !== undefined) config.supportEmail = supportEmail.trim()
    if (supportPhone !== undefined) config.supportPhone = supportPhone.trim()
    if (supportTelegram !== undefined) config.supportTelegram = supportTelegram.trim()
    if (supportWhatsapp !== undefined) config.supportWhatsapp = supportWhatsapp.trim()

    if (stripe) {
      if (!config.stripe) {
        config.stripe = {
          publishableKey: '',
          secretKey: '',
          webhookSecret: '',
          isConfigured: false,
          mode: 'test',
        }
      }

      if (stripe.publishableKey !== undefined) {
        config.stripe.publishableKey = stripe.publishableKey.trim()
      }

      // Only update secret key if non-masked new value is provided
      if (stripe.secretKey && !stripe.secretKey.includes('...')) {
        config.stripe.secretKey = stripe.secretKey.trim()
      }

      if (stripe.webhookSecret && !stripe.webhookSecret.includes('••••')) {
        config.stripe.webhookSecret = stripe.webhookSecret.trim()
      }

      if (stripe.mode && ['test', 'live'].includes(stripe.mode)) {
        config.stripe.mode = stripe.mode
      }

      config.stripe.isConfigured = Boolean(config.stripe.publishableKey && config.stripe.secretKey)
    }

    await config.save()

    return res.status(200).json({
      success: true,
      message: 'Platform settings updated successfully.',
      settings: {
        siteName: config.siteName,
        setupFeePriceUSD: config.setupFeePriceUSD,
        setupFeePresetAltUSD: config.setupFeePresetAltUSD,
        officialGithubHandle: config.officialGithubHandle,
        affiliateCommissionRate: config.affiliateCommissionRate,
        stripe: {
          publishableKey: config.stripe?.publishableKey || '',
          hasSecretKey: Boolean(config.stripe?.secretKey),
          isConfigured: Boolean(config.stripe?.isConfigured),
          mode: config.stripe?.mode || 'test',
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 2. MERCHANT: Setup Status & Checkout Session
// ----------------------------------------------------
export async function getMerchantSetupStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant
    if (!merchant) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const config = await getOrCreateSystemConfig()

    return res.status(200).json({
      success: true,
      setup: {
        merchantId: merchant._id,
        fullName: merchant.fullName,
        businessEmail: merchant.businessEmail,
        websiteDomain: merchant.websiteDomain || merchant.website || '',
        gitRepoUrl: merchant.gitRepoUrl || '',
        setupStatus: merchant.setupStatus || 'pending_payment',
        setupFeeAmount: merchant.setupFeeAmount || config.setupFeePriceUSD || 49.0,
        setupPaidAt: merchant.setupPaidAt || null,
        gitCollabStatus: merchant.gitCollabStatus || 'pending',
        envConfig: merchant.envConfig || '',
        officialGithubHandle: config.officialGithubHandle || 'huipper-dev',
        setupFeePriceUSD: config.setupFeePriceUSD || 450.0,
        setupFeePresetAltUSD: config.setupFeePresetAltUSD || 565.0,
        resellerId: merchant.resellerId || 'admin_root',
        isStripeReady: Boolean(config.stripe?.isConfigured && config.stripe?.secretKey),
        hostingProvider: merchant.hostingProvider || '',
        techStack: merchant.techStack || '',
        companyDescription: merchant.companyDescription || '',
        brandLogoUrl: merchant.brandLogoUrl || '',
        primaryColor: merchant.primaryColor || '#D946EF',
        secondaryColor: merchant.secondaryColor || '#00F0FF',
        preferredDomain: merchant.preferredDomain || '',
        altDomain: merchant.altDomain || '',
        integrationNotes: merchant.integrationNotes || '',
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function createSetupCheckoutSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant
    if (!merchant) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const { websiteDomain, gitRepoUrl } = req.body
    if (websiteDomain) merchant.websiteDomain = websiteDomain.trim()
    if (gitRepoUrl) merchant.gitRepoUrl = gitRepoUrl.trim()

    const config = await getOrCreateSystemConfig()

    if (!config.stripe?.secretKey || !config.stripe?.isConfigured) {
      return res.status(400).json({
        success: false,
        message: 'Platform Stripe payment gateway is not yet configured by the Super Administrator.',
      })
    }

    const appOrigin = req.headers.origin || 'http://localhost:5173'
    const successUrl = `${appOrigin}/dashboard?setup_payment=success&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${appOrigin}/dashboard?setup_payment=cancelled`

    const feeAmount = config.setupFeePriceUSD || 450.0

    const session = await createStripeCheckoutSession({
      secretKey: config.stripe.secretKey,
      amount: feeAmount,
      currency: 'usd',
      productName: `PGX Gateway Setup & White-Glove Integration`,
      merchantRefId: merchant.refId || String(merchant._id),
      resellerId: merchant.resellerId || 'admin_root',
      customerEmail: merchant.businessEmail,
      orderId: `SETUP-${merchant._id.toString().slice(-6).toUpperCase()}`,
      successUrl,
      cancelUrl,
      metadata: {
        type: 'setup_fee',
        merchantId: merchant._id.toString(),
        resellerId: merchant.resellerId || 'admin_root',
      },
    })

    merchant.setupStripeSessionId = session.id
    merchant.setupFeeAmount = feeAmount
    await merchant.save()

    return res.status(200).json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      amount: feeAmount,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 3. MERCHANT: Submit Collaboration & .env Variables
// ----------------------------------------------------
export async function submitCollabDetails(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant
    if (!merchant) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const {
      websiteDomain,
      gitRepoUrl,
      envConfig,
      inviteSent,
      hostingProvider,
      techStack,
      companyDescription,
      brandLogoUrl,
      primaryColor,
      secondaryColor,
      preferredDomain,
      altDomain,
      integrationNotes,
    } = req.body

    if (websiteDomain) merchant.websiteDomain = websiteDomain.trim()
    if (gitRepoUrl) merchant.gitRepoUrl = gitRepoUrl.trim()
    if (envConfig !== undefined) merchant.envConfig = envConfig.trim()
    if (hostingProvider !== undefined) merchant.hostingProvider = hostingProvider.trim()
    if (techStack !== undefined) merchant.techStack = techStack.trim()
    if (companyDescription !== undefined) merchant.companyDescription = companyDescription.trim()
    if (brandLogoUrl !== undefined) merchant.brandLogoUrl = brandLogoUrl.trim()
    if (primaryColor !== undefined) merchant.primaryColor = primaryColor.trim()
    if (secondaryColor !== undefined) merchant.secondaryColor = secondaryColor.trim()
    if (preferredDomain !== undefined) merchant.preferredDomain = preferredDomain.trim()
    if (altDomain !== undefined) merchant.altDomain = altDomain.trim()
    if (integrationNotes !== undefined) merchant.integrationNotes = integrationNotes.trim()

    if (inviteSent) {
      merchant.gitCollabStatus = 'invite_sent'
    }

    // Advance status to under_review / collab_submitted per PRD Section 06
    if (
      merchant.setupStatus === 'paid_setup' ||
      merchant.setupStatus === 'pending_payment' ||
      merchant.setupStatus === 'payment_pending' ||
      merchant.setupStatus === 'information_pending'
    ) {
      merchant.setupStatus = 'under_review'
    }

    await merchant.save()

    // Notify Super Admin
    await Notification.create({
      merchantId: merchant._id,
      title: 'GitHub Collaboration & .env Submitted',
      content: `Merchant ${merchant.fullName} (${merchant.businessEmail}) submitted GitHub repo and environment credentials for setup.`,
      type: 'system',
    })

    emitToAdmins(WS_EVENTS.DOCUMENT_UPLOADED, {
      merchantId: merchant._id,
      fullName: merchant.fullName,
      businessEmail: merchant.businessEmail,
      gitRepoUrl: merchant.gitRepoUrl,
      setupStatus: merchant.setupStatus,
    })

    return res.status(200).json({
      success: true,
      message: 'Integration collaboration details and environment config saved successfully.',
      setup: {
        merchantId: merchant._id,
        websiteDomain: merchant.websiteDomain,
        gitRepoUrl: merchant.gitRepoUrl,
        gitCollabStatus: merchant.gitCollabStatus,
        setupStatus: merchant.setupStatus,
        envConfig: merchant.envConfig,
      },
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 4. MESSAGING: Merchant <-> Super Admin Setup Chat
// ----------------------------------------------------
export async function getSetupMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = String(req.params.merchantId || '')
    if (!merchantId) {
      return res.status(400).json({ success: false, message: 'merchantId is required' })
    }

    const messages = await SetupMessage.find({ merchantId }).sort({ createdAt: 1 }).lean()

    return res.status(200).json({
      success: true,
      messages,
    })
  } catch (error) {
    next(error)
  }
}

export async function sendSetupMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = String(req.params.merchantId || '')
    const { message, senderRole, senderName } = req.body

    if (!merchantId || !message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message content is required.' })
    }

    const cleanSenderRole = senderRole === 'super_admin' ? 'super_admin' : 'merchant'
    const cleanSenderName = senderName?.trim() || (cleanSenderRole === 'super_admin' ? 'Super Admin Support' : 'Merchant')

    const newMsg = await SetupMessage.create({
      merchantId,
      senderRole: cleanSenderRole,
      senderName: cleanSenderName,
      message: message.trim(),
      read: false,
    })

    // If super admin sent message, notify merchant
    if (cleanSenderRole === 'super_admin') {
      emitToMerchant(merchantId, 'setup_message_received', newMsg)
      await Notification.create({
        merchantId,
        title: 'New Integration Message from Super Admin',
        content: message.slice(0, 120),
        type: 'system',
      })
    } else {
      // If merchant sent message, notify super admin
      emitToAdmins('setup_message_received', { merchantId, message: newMsg })
    }

    return res.status(201).json({
      success: true,
      message: newMsg,
    })
  } catch (error) {
    next(error)
  }
}

// ----------------------------------------------------
// 5. SUPER ADMIN: Integrations Desk & Status Management
// ----------------------------------------------------
export async function getAdminIntegrations(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { status, search } = req.query

    const filter: any = {}
    if (status && status !== 'all') {
      filter.setupStatus = status
    }

    if (search && typeof search === 'string') {
      filter.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { businessEmail: { $regex: search, $options: 'i' } },
        { websiteDomain: { $regex: search, $options: 'i' } },
        { gitRepoUrl: { $regex: search, $options: 'i' } },
      ]
    }

    const merchants = await Merchant.find(filter)
      .select('fullName businessEmail phone website websiteDomain gitRepoUrl setupStatus setupFeeAmount setupPaidAt gitCollabStatus envConfig resellerId hostingProvider techStack companyDescription preferredDomain altDomain integrationNotes createdAt')
      .sort({ updatedAt: -1 })
      .lean()

    // Count statistics matching PRD Section 06
    const stats = {
      total: merchants.length,
      payment_pending: merchants.filter((m) => ['payment_pending', 'pending_payment'].includes(m.setupStatus as string)).length,
      information_pending: merchants.filter((m) => ['information_pending', 'paid_setup'].includes(m.setupStatus as string)).length,
      under_review: merchants.filter((m) => ['under_review', 'collab_submitted'].includes(m.setupStatus as string)).length,
      in_development: merchants.filter((m) => ['in_development', 'in_progress'].includes(m.setupStatus as string)).length,
      integration_testing: merchants.filter((m) => m.setupStatus === 'integration_testing').length,
      completed: merchants.filter((m) => m.setupStatus === 'completed').length,
      delivered: merchants.filter((m) => m.setupStatus === 'delivered').length,
    }

    return res.status(200).json({
      success: true,
      stats,
      merchants,
    })
  } catch (error) {
    next(error)
  }
}

export async function updateAdminIntegrationStatus(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { merchantId } = req.params
    const { setupStatus, gitCollabStatus } = req.body

    const update: any = {}
    if (setupStatus) update.setupStatus = setupStatus
    if (gitCollabStatus) update.gitCollabStatus = gitCollabStatus

    const updated = await Merchant.findByIdAndUpdate(merchantId, { $set: update }, { new: true })
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Merchant not found' })
    }

    // Notify merchant
    await Notification.create({
      merchantId: updated._id,
      title: 'Integration Status Update',
      content: `Your website integration status has been updated to: ${updated.setupStatus?.toUpperCase()}`,
      type: 'system',
    })

    emitToMerchant(String(updated._id), 'setup_status_updated', {
      setupStatus: updated.setupStatus,
      gitCollabStatus: updated.gitCollabStatus,
    })

    return res.status(200).json({
      success: true,
      message: 'Integration status updated successfully',
      merchant: updated,
    })
  } catch (error) {
    next(error)
  }
}
