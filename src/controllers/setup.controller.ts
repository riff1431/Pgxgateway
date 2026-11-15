import { Request, Response, NextFunction } from 'express'
import { SystemConfig, ISystemConfig } from '../models/SystemConfig.js'
import { Merchant } from '../models/Merchant.js'
import { SetupMessage } from '../models/SetupMessage.js'
import { ResellerConfig } from '../models/ResellerConfig.js'
import { Notification } from '../models/Notification.js'
import { createStripeCheckoutSession, getStripeClient, getOrCreateStripeCustomer } from '../services/stripe.service.js'
import { parseMonthlyFee } from '../services/subscription.service.js'
import { emitToAdmins, emitToMerchant, WS_EVENTS } from '../services/socket.service.js'
import { AuthRequest } from '../middleware/auth.middleware.js'
import { AdminRequest } from '../middleware/admin.middleware.js'
import { config as envConfig } from '../config/env.js'

async function getOrCreateSystemConfig(): Promise<ISystemConfig> {
  let config = await SystemConfig.findOne()
  if (!config) {
    config = await SystemConfig.create({
      siteName: 'PGX Gateway',
      setupFeePriceUSD: 450.0,
      setupFeePresetAltUSD: 565.0,
      officialGithubHandle: 'huipper-dev',
      affiliateCommissionRate: 20.0,
      supportWhatsapp: '+1 (437) 577-8785',
      stripe: {
        publishableKey: '',
        secretKey: '',
        webhookSecret: '',
        isConfigured: false,
        mode: 'test',
      },
      cryptoWallets: {
        btcAddress: '3DyMA7VZavn4iA4m4scrjMHJyaEn1XRmaz',
        usdcEthAddress: '0x4520FBE6d418c1bAcE97A1E517e5Be2d78eb9598',
      },
    })
  } else {
    let changed = false
    if (!config.supportWhatsapp || config.supportWhatsapp === '+1 (800) 749-4283') {
      config.supportWhatsapp = '+1 (437) 577-8785'
      changed = true
    }
    if (!config.cryptoWallets || !config.cryptoWallets.btcAddress || !config.cryptoWallets.usdcEthAddress) {
      config.cryptoWallets = {
        btcAddress: config.cryptoWallets?.btcAddress || '3DyMA7VZavn4iA4m4scrjMHJyaEn1XRmaz',
        usdcEthAddress: config.cryptoWallets?.usdcEthAddress || '0x4520FBE6d418c1bAcE97A1E517e5Be2d78eb9598',
      }
      changed = true
    }
    if (changed) {
      await config.save()
    }
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
        cryptoWallets: {
          btcAddress: config.cryptoWallets?.btcAddress || '3DyMA7VZavn4iA4m4scrjMHJyaEn1XRmaz',
          usdcEthAddress: config.cryptoWallets?.usdcEthAddress || '0x4520FBE6d418c1bAcE97A1E517e5Be2d78eb9598',
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

    if (req.body.cryptoWallets) {
      if (!config.cryptoWallets) {
        config.cryptoWallets = {
          btcAddress: '3DyMA7VZavn4iA4m4scrjMHJyaEn1XRmaz',
          usdcEthAddress: '0x4520FBE6d418c1bAcE97A1E517e5Be2d78eb9598',
        }
      }
      if (req.body.cryptoWallets.btcAddress !== undefined) {
        config.cryptoWallets.btcAddress = req.body.cryptoWallets.btcAddress.trim()
      }
      if (req.body.cryptoWallets.usdcEthAddress !== undefined) {
        config.cryptoWallets.usdcEthAddress = req.body.cryptoWallets.usdcEthAddress.trim()
      }
    }

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

      // Sync Stripe credentials to Primary Gateway (admin_root / PlayGroundX)
      // so that both Setup Fees and Sub-Merchant checkouts are routed seamlessly
      try {
        await ResellerConfig.findOneAndUpdate(
          { resellerId: 'admin_root' },
          {
            $set: {
              'stripe.publishableKey': config.stripe.publishableKey,
              ...(config.stripe.secretKey ? { 'stripe.secretKey': config.stripe.secretKey } : {}),
              ...(config.stripe.webhookSecret ? { 'stripe.webhookSecret': config.stripe.webhookSecret } : {}),
              'stripe.mode': config.stripe.mode,
              'stripe.isConfigured': config.stripe.isConfigured,
            },
          },
          { upsert: true }
        )
      } catch (syncErr) {
        console.warn('[Platform Settings] Warning syncing Stripe config to admin_root:', syncErr)
      }
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
// 1.1 SUPER ADMIN: Test Stripe API Connection
// ----------------------------------------------------
export async function testStripeConnection(req: AdminRequest, res: Response, _next: NextFunction) {
  try {
    const { secretKey } = req.body
    let keyToTest = (secretKey || '').trim()

    // If key not passed or masked, fall back to saved config
    if (!keyToTest || keyToTest.includes('••••') || keyToTest.includes('...')) {
      const config = await getOrCreateSystemConfig()
      keyToTest = config.stripe?.secretKey || ''
    }

    if (!keyToTest) {
      return res.status(400).json({
        success: false,
        message: 'No Stripe Secret Key found to test. Please enter a valid Stripe Secret Key (sk_live_... or sk_test_...).',
      })
    }

    // Call Stripe official API directly to test authentication
    const stripe = getStripeClient(keyToTest)
    const balance = await stripe.balance.retrieve()

    const currencies = Array.from(new Set(balance.available.map((b) => b.currency.toUpperCase())))

    return res.status(200).json({
      success: true,
      livemode: balance.livemode,
      currencies,
      message: `Stripe authenticated successfully! Connected in ${balance.livemode ? 'LIVE PRODUCTION' : 'TEST'} mode. Supported currencies: ${currencies.join(', ') || 'USD'}.`,
    })
  } catch (error: any) {
    console.error('[Stripe Test Connection] Error:', error)
    return res.status(400).json({
      success: false,
      message: error?.message || 'Failed to authenticate with Stripe. Please check your Secret Key.',
    })
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

    let rawSetupFee = config.setupFeePriceUSD || 450.0
    if (merchant.offer?.setupFee) {
      const parsed = parseFloat(String(merchant.offer.setupFee).replace(/[^0-9.]/g, ''))
      if (!isNaN(parsed) && parsed > 0) {
        rawSetupFee = parsed
      }
    }

    return res.status(200).json({
      success: true,
      setup: {
        merchantId: merchant._id,
        fullName: merchant.fullName,
        businessEmail: merchant.businessEmail,
        websiteDomain: merchant.websiteDomain || merchant.website || '',
        gitRepoUrl: merchant.gitRepoUrl || '',
        setupStatus: merchant.setupStatus || 'pending_payment',
        setupFeeAmount: merchant.setupFeeAmount || rawSetupFee,
        setupPaidAt: merchant.setupPaidAt || null,
        gitCollabStatus: merchant.gitCollabStatus || 'pending',
        envConfig: merchant.envConfig || '',
        officialGithubHandle: config.officialGithubHandle || 'huipper-dev',
        setupFeePriceUSD: rawSetupFee,
        setupFeePresetAltUSD: config.setupFeePresetAltUSD || 565.0,
        resellerId: merchant.resellerId || 'admin_root',
        isStripeReady: Boolean(config.stripe?.isConfigured && config.stripe?.secretKey),
        supportWhatsapp: config.supportWhatsapp && config.supportWhatsapp !== '+1 (800) 749-4283' ? config.supportWhatsapp : '+1 (437) 577-8785',
        hostingProvider: merchant.hostingProvider || '',
        techStack: merchant.techStack || '',
        companyDescription: merchant.companyDescription || '',
        brandLogoUrl: merchant.brandLogoUrl || '',
        primaryColor: merchant.primaryColor || '#D946EF',
        secondaryColor: merchant.secondaryColor || '#00F0FF',
        preferredDomain: merchant.preferredDomain || '',
        altDomain: merchant.altDomain || '',
        integrationNotes: merchant.integrationNotes || '',
        subscription: merchant.subscription || {
          status: 'none',
          monthlyFee: parseMonthlyFee(merchant.offer?.monthlyFee) || 99.0,
          autoRenew: true,
        },
        cryptoWallets: {
          btcAddress: config.cryptoWallets?.btcAddress || '3DyMA7VZavn4iA4m4scrjMHJyaEn1XRmaz',
          usdcEthAddress: config.cryptoWallets?.usdcEthAddress || '0x4520FBE6d418c1bAcE97A1E517e5Be2d78eb9598',
        },
        cryptoPayment: merchant.cryptoPayment || null,
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

    const appOrigin = req.headers.origin || 'https://pgxgateway.com'
    const successUrl = `${appOrigin}/dashboard?tab=integration&setup_payment=success&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${appOrigin}/dashboard?tab=integration&setup_payment=cancelled`

    let rawSetupFee = config.setupFeePriceUSD || 450.0
    if (merchant.offer?.setupFee) {
      const parsed = parseFloat(String(merchant.offer.setupFee).replace(/[^0-9.]/g, ''))
      if (!isNaN(parsed) && parsed > 0) {
        rawSetupFee = parsed
      }
    }

    // 3% Stripe processing fee surcharge as requested by client
    const stripeSurcharge = Math.round(rawSetupFee * 0.03 * 100) / 100
    const totalAmountWithSurcharge = Math.round((rawSetupFee + stripeSurcharge) * 100) / 100

    // 1. Primary Route: E-Commerce Payment Bridge (pgxdigital.shop)
    if (envConfig.ecomBridge?.enabled && envConfig.ecomBridge?.url) {
      try {
        const bridgeEndpoint = `${envConfig.ecomBridge.url.replace(/\/+$/, '')}/api/gateway-bridge/initiate`
        console.log(`[Setup Checkout] Routing setup fee payment through E-Commerce Bridge: ${bridgeEndpoint} for merchant ${merchant.refId}`)

        const bridgeRes = await fetch(bridgeEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-gateway-bridge-secret': envConfig.ecomBridge.secret,
          },
          body: JSON.stringify({
            merchantRefId: merchant.refId || String(merchant._id),
            resellerId: merchant.resellerId || 'admin_root',
            orderId: `SETUP-${merchant._id.toString().slice(-6).toUpperCase()}`,
            amount: totalAmountWithSurcharge,
            currency: 'USD',
            customerEmail: merchant.businessEmail,
            customerName: merchant.legalName || merchant.fullName,
            productName: `PGX Enterprise Software License & Merchant Onboarding Kit`,
            successUrl,
            cancelUrl,
            mode: config.stripe?.mode === 'live' ? 'live' : 'test',
          }),
        })

        if (bridgeRes.ok) {
          const bridgeData = (await bridgeRes.json()) as any
          const sessionId = bridgeData.sessionId || bridgeData.data?.sessionId
          const checkoutUrl = bridgeData.checkoutUrl || bridgeData.data?.checkoutUrl
          return res.status(200).json({
            success: true,
            checkoutUrl,
            sessionId,
            amount: totalAmountWithSurcharge,
            baseAmount: rawSetupFee,
            surcharge: stripeSurcharge,
            mode: 'ecom_bridge',
          })
        } else {
          const errText = await bridgeRes.text()
          console.warn(`[Setup Checkout] E-Commerce Bridge returned error: ${bridgeRes.status} ${errText}. Attempting direct Stripe fallback...`)
        }
      } catch (bridgeErr: any) {
        console.error(`[Setup Checkout] Failed to reach E-Commerce Bridge: ${bridgeErr.message}. Attempting direct Stripe fallback...`)
      }
    }

    // 2. Fallback: Direct Platform Stripe Configuration
    if (!config.stripe?.secretKey || !config.stripe?.isConfigured) {
      return res.status(503).json({
        success: false,
        message: 'Platform payment gateway is currently unavailable. Please verify E-Commerce Bridge or Super Admin Stripe credentials.',
      })
    }

    // Handle dummy/sample keys seamlessly for testing & QA simulation
    if (config.stripe.secretKey.startsWith('sk_test_sample')) {
      const simulatedSessionId = `cs_test_simulated_${Date.now()}`
      merchant.setupStripeSessionId = simulatedSessionId
      merchant.setupFeeAmount = rawSetupFee
      merchant.setupPaidAt = new Date()
      merchant.setupStatus = 'information_pending'
      merchant.accountMode = 'live'
      if (merchant.trial) {
        merchant.trial.isActive = false
        merchant.trial.status = 'converted'
      }
      merchant.subscription = {
        status: 'active',
        monthlyFee: parseMonthlyFee(merchant.offer?.monthlyFee) || 99.0,
        nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        lastBilledDate: new Date(),
        autoRenew: true,
        failureCount: 0,
      }

      // Accrue 20% affiliate commission to reseller
      const commissionRate = config.affiliateCommissionRate || 20.0
      const commissionEarned = (rawSetupFee * commissionRate) / 100.0
      merchant.affiliateCommissionEarned = commissionEarned
      await merchant.save()

      if (merchant.resellerId) {
        await ResellerConfig.findOneAndUpdate(
          { resellerId: merchant.resellerId },
          {
            $inc: {
              prepaidBalance: commissionEarned,
              totalResellerProfit: commissionEarned,
            },
          }
        )
      }

      return res.status(200).json({
        success: true,
        checkoutUrl: `${appOrigin}/dashboard?tab=integration&setup_payment=success&simulated=true`,
        sessionId: simulatedSessionId,
        amount: totalAmountWithSurcharge,
        baseAmount: rawSetupFee,
        surcharge: stripeSurcharge,
      })
    }

    // Tokenize card for off_session auto-renewal by linking a persistent Stripe Customer
    let customerId: string | undefined = merchant.subscription?.stripeCustomerId
    try {
      if (!customerId) {
        const stripeCustomer = await getOrCreateStripeCustomer({
          secretKey: config.stripe.secretKey,
          email: merchant.businessEmail,
          name: merchant.legalName || merchant.fullName,
          merchantRefId: merchant.refId || String(merchant._id),
          metadata: {
            merchantId: String(merchant._id),
            resellerId: merchant.resellerId || 'admin_root',
          },
        })
        customerId = stripeCustomer.id
        merchant.subscription = {
          ...(merchant.subscription || { autoRenew: true }),
          stripeCustomerId: customerId,
          monthlyFee: parseMonthlyFee(merchant.offer?.monthlyFee) || 99.0,
          status: merchant.subscription?.status || 'none',
          autoRenew: true,
        }
      }
    } catch (custErr) {
      console.warn('[Setup Checkout] Warning fetching/creating Stripe customer:', custErr)
    }

    const session = await createStripeCheckoutSession({
      secretKey: config.stripe.secretKey,
      amount: totalAmountWithSurcharge,
      currency: 'usd',
      productName: `Setup & Integration`,
      merchantRefId: merchant.refId || String(merchant._id),
      resellerId: merchant.resellerId || 'admin_root',
      customerId,
      customerEmail: merchant.businessEmail,
      setupFutureUsage: 'off_session',
      orderId: `SETUP-${merchant._id.toString().slice(-6).toUpperCase()}`,
      successUrl,
      cancelUrl,
      lineItems: [
        {
          name: 'Setup & Integration',
          description: `Account Activation & Dedicated Underwriting Desk for ${merchant.legalName || merchant.fullName}`,
          amount: rawSetupFee,
          quantity: 1,
        },
        {
          name: 'Stripe Card Processing Surcharge (3%)',
          description: 'Standard 3% credit/debit card payment processing surcharge',
          amount: stripeSurcharge,
          quantity: 1,
        },
      ],
      metadata: {
        type: 'setup_fee',
        merchantId: merchant._id.toString(),
        resellerId: merchant.resellerId || 'admin_root',
        baseFee: String(rawSetupFee),
        stripeSurcharge: String(stripeSurcharge),
        customerId: customerId || '',
      },
    })

    merchant.setupStripeSessionId = session.id
    merchant.setupFeeAmount = rawSetupFee
    await merchant.save()

    return res.status(200).json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      amount: totalAmountWithSurcharge,
      baseAmount: rawSetupFee,
      surcharge: stripeSurcharge,
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

// ----------------------------------------------------
// 7. CRYPTO PAYMENT: Submit Proof & Verify (BTC / USDC)
// ----------------------------------------------------
export async function submitCryptoPayment(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchant = req.merchant
    if (!merchant) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const { currency, txHash, senderAddress, websiteDomain, gitRepoUrl } = req.body
    if (!currency || !['BTC', 'USDC'].includes(currency)) {
      return res.status(400).json({ success: false, message: 'Invalid currency. Must be BTC or USDC.' })
    }
    if (!txHash || typeof txHash !== 'string' || txHash.trim().length < 8) {
      return res.status(400).json({ success: false, message: 'Valid blockchain Transaction Hash (TxID) is required.' })
    }

    if (websiteDomain) merchant.websiteDomain = websiteDomain.trim()
    if (gitRepoUrl) merchant.gitRepoUrl = gitRepoUrl.trim()

    const config = await getOrCreateSystemConfig()
    let rawSetupFee = config.setupFeePriceUSD || 450.0
    if (merchant.offer?.setupFee) {
      const parsed = parseFloat(String(merchant.offer.setupFee).replace(/[^0-9.]/g, ''))
      if (!isNaN(parsed) && parsed > 0) {
        rawSetupFee = parsed
      }
    }

    const network = currency === 'USDC' ? 'Ethereum (ERC-20)' : 'Bitcoin Network'

    merchant.cryptoPayment = {
      currency,
      network,
      txHash: txHash.trim(),
      senderAddress: senderAddress ? String(senderAddress).trim() : '',
      amount: rawSetupFee,
      submittedAt: new Date(),
      status: 'pending',
    }
    merchant.setupStatus = 'crypto_pending'
    await merchant.save()

    // Notify Super Admin
    await Notification.create({
      merchantId: merchant._id,
      title: '🪙 Crypto Payment Proof Submitted',
      content: `Merchant ${merchant.fullName} (${merchant.refId || 'N/A'}) submitted ${currency} transfer proof (${txHash.trim()}) for Setup Fee ($${rawSetupFee}). Verification required.`,
      type: 'system',
    })

    emitToAdmins('admin_crypto_payment_received', {
      merchantId: merchant._id,
      merchantName: merchant.fullName,
      refId: merchant.refId,
      currency,
      network,
      txHash: txHash.trim(),
      amount: rawSetupFee,
      submittedAt: new Date(),
    })

    return res.status(200).json({
      success: true,
      message: 'Crypto payment proof submitted successfully. Super Admin will verify on blockchain and activate your gateway integration.',
      cryptoPayment: merchant.cryptoPayment,
    })
  } catch (error) {
    next(error)
  }
}

export async function verifyCryptoPayment(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { merchantId } = req.params
    const { action, notes, activateLive } = req.body // action: 'approve' | 'reject'

    const merchant = await Merchant.findById(merchantId)
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' })
    }

    if (!merchant.cryptoPayment) {
      return res.status(400).json({ success: false, message: 'No crypto payment submission found for this merchant' })
    }

    const config = await getOrCreateSystemConfig()

    if (action === 'reject') {
      merchant.cryptoPayment.status = 'rejected'
      merchant.cryptoPayment.notes = notes || 'Transaction hash could not be verified on blockchain.'
      merchant.setupStatus = 'pending_payment'
      await merchant.save()

      await Notification.create({
        merchantId: merchant._id,
        title: 'Crypto Payment Verification Declined',
        content: `Your crypto payment proof could not be verified: ${merchant.cryptoPayment.notes}. Please check your TxID or contact support.`,
        type: 'system',
      })

      return res.status(200).json({
        success: true,
        message: 'Crypto payment rejected',
        merchant,
      })
    }

    // Approve / Verify
    merchant.cryptoPayment.status = 'verified'
    merchant.cryptoPayment.verifiedAt = new Date()
    merchant.cryptoPayment.verifiedBy = req.admin?.email || 'super_admin'
    if (notes) merchant.cryptoPayment.notes = notes

    const rawSetupFee = merchant.cryptoPayment.amount || config.setupFeePriceUSD || 450.0
    merchant.setupFeeAmount = rawSetupFee
    merchant.setupPaidAt = new Date()
    merchant.setupStatus = 'information_pending'

    if (activateLive) {
      merchant.accountMode = 'live'
      if (merchant.trial) {
        merchant.trial.isActive = false
        merchant.trial.status = 'converted'
      }
    }

    // Accrue 20% affiliate commission if merchant belongs to a reseller
    if (merchant.resellerId && merchant.resellerId !== 'admin_root') {
      const commissionRate = config.affiliateCommissionRate || 20.0
      const commissionEarned = (rawSetupFee * commissionRate) / 100.0
      merchant.affiliateCommissionEarned = commissionEarned

      await ResellerConfig.findOneAndUpdate(
        { resellerId: merchant.resellerId },
        {
          $inc: {
            prepaidBalance: commissionEarned,
            totalResellerProfit: commissionEarned,
          },
        }
      )
    }

    await merchant.save()

    // Notify Merchant
    await Notification.create({
      merchantId: merchant._id,
      title: '✅ Crypto Payment Verified & Confirmed',
      content: `Your ${merchant.cryptoPayment.currency} setup payment ($${rawSetupFee}) has been verified on blockchain. Gateway integration is now unlocked!`,
      type: 'system',
    })

    emitToMerchant(String(merchant._id), 'setup_status_updated', {
      setupStatus: merchant.setupStatus,
      accountMode: merchant.accountMode,
    })

    return res.status(200).json({
      success: true,
      message: 'Crypto payment verified successfully',
      merchant,
    })
  } catch (error) {
    next(error)
  }
}
