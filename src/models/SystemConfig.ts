import mongoose, { Document, Schema } from 'mongoose'

export type BridgeProfile = 'marketplace' | 'leads' | '1pay'

export const VALID_BRIDGE_PROFILES: readonly BridgeProfile[] = ['marketplace', 'leads', '1pay'] as const

export interface ISystemConfig extends Document {
  siteName: string
  logoUrl?: string
  faviconUrl?: string
  supportEmail?: string
  supportPhone?: string
  supportTelegram?: string
  supportWhatsapp?: string
  stripe?: {
    publishableKey: string
    secretKey: string
    webhookSecret: string
    isConfigured: boolean
    mode: 'test' | 'live'
  }
  onePay?: {
    liveApiKey: string
    testApiKey: string
    liveWebhookSecret: string
    testWebhookSecret: string
    liveEndpointSecret: string
    testEndpointSecret: string
    webhookUrl: string
    enabled: boolean
    isConfigured: boolean
  }
  cryptoWallets?: {
    btcAddress: string
    usdcEthAddress: string
  }
  mailgun?: {
    apiKey: string
    domain: string
    from: string
  }
  setupFeePriceUSD: number
  setupFeePresetAltUSD: number
  officialGithubHandle: string
  affiliateCommissionRate: number
  updatedAt: Date
  createdAt: Date
}

const SystemConfigSchema = new Schema<ISystemConfig>(
  {
    siteName: {
      type: String,
      required: true,
      default: 'PGX Gateway',
      trim: true,
    },
    logoUrl: {
      type: String,
      default: '',
      trim: true,
    },
    faviconUrl: {
      type: String,
      default: '/favicon.svg',
      trim: true,
    },
    supportEmail: {
      type: String,
      default: 'support@pgxgateway.com',
      trim: true,
    },
    supportPhone: {
      type: String,
      default: '+1 (800) 749-4283',
      trim: true,
    },
    supportTelegram: {
      type: String,
      default: '@pgxsupport',
      trim: true,
    },
    supportWhatsapp: {
      type: String,
      default: '+1 (437) 577-8785',
      trim: true,
    },
    stripe: {
      publishableKey: { type: String, default: '', trim: true },
      secretKey: { type: String, default: '', trim: true },
      webhookSecret: { type: String, default: '', trim: true },
      isConfigured: { type: Boolean, default: false },
      mode: { type: String, enum: ['test', 'live'], default: 'test' },
    },
    onePay: {
      liveApiKey: { type: String, default: '', trim: true },
      testApiKey: { type: String, default: '', trim: true },
      liveWebhookSecret: { type: String, default: '', trim: true },
      testWebhookSecret: { type: String, default: '', trim: true },
      liveEndpointSecret: { type: String, default: '', trim: true },
      testEndpointSecret: { type: String, default: '', trim: true },
      webhookUrl: { type: String, default: 'https://api.pgxgateway.com/api/v1/webhooks/1pay', trim: true },
      enabled: { type: Boolean, default: false },
      isConfigured: { type: Boolean, default: false },
    },
    cryptoWallets: {
      btcAddress: { type: String, default: '3DyMA7VZavn4iA4m4scrjMHJyaEn1XRmaz', trim: true },
      usdcEthAddress: { type: String, default: '0x4520FBE6d418c1bAcE97A1E517e5Be2d78eb9598', trim: true },
    },
    mailgun: {
      apiKey: { type: String, default: '', trim: true },
      domain: { type: String, default: 'pgxgateway.com', trim: true },
      from: { type: String, default: 'PGX Gateway <support@pgxgateway.com>', trim: true },
    },
    setupFeePriceUSD: {
      type: Number,
      default: 999.0,
      min: 0,
    },
    setupFeePresetAltUSD: {
      type: Number,
      default: 565.0, // PRD v1.0 Section 01 turnkey VIP tier
      min: 0,
    },
    officialGithubHandle: {
      type: String,
      default: 'huipper-dev',
      trim: true,
    },
    affiliateCommissionRate: {
      type: Number,
      default: 20.0, // 20% commission to referring reseller
      min: 0,
      max: 100,
    },
  },
  {
    timestamps: true,
  }
)

export const SystemConfig = mongoose.model<ISystemConfig>('SystemConfig', SystemConfigSchema)
