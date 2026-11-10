import mongoose, { Document, Schema } from 'mongoose'

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
    setupFeePriceUSD: {
      type: Number,
      default: 450.0, // PRD v1.0 Section 01 default working example
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
