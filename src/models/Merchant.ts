import mongoose, { Document, Schema } from 'mongoose'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

export interface IMerchant extends Document {
  // Account Information (Step 1)
  fullName: string
  businessEmail: string
  phone: string
  whatsapp?: string
  telegram?: string
  password?: string

  // Business & Processing Information (Step 2)
  legalName?: string
  industry?: string
  website?: string
  yearsInBusiness?: string
  currentProcessor?: string
  monthlyVolume?: string
  avgTransaction?: string
  chargebackRate?: string
  switchReason?: string

  // Verification & Documents (Step 3)
  businessRegDoc?: {
    name: string
    url?: string
    path?: string
    size?: string
    uploadedAt: Date
  }
  directorIdDoc?: {
    name: string
    url?: string
    path?: string
    size?: string
    uploadedAt: Date
  }
  processingStatementDoc?: {
    name: string
    url?: string
    path?: string
    size?: string
    uploadedAt: Date
  }
  agreedToTerms: boolean

  // Website & Git Integration Setup (PRD Section 05 & 06)
  websiteDomain?: string
  gitRepoUrl?: string
  setupStatus?:
    | 'payment_pending'
    | 'information_pending'
    | 'under_review'
    | 'in_development'
    | 'integration_testing'
    | 'completed'
    | 'delivered'
    | 'pending_payment'
    | 'paid_setup'
    | 'collab_submitted'
    | 'in_progress'
  setupFeeAmount?: number
  setupPaidAt?: Date
  setupStripeSessionId?: string
  gitCollabStatus?: 'pending' | 'invite_sent' | 'accepted'
  envConfig?: string
  affiliateCommissionEarned?: number

  // PRD Onboarding Metadata (PRD Section 05)
  hostingProvider?: string
  techStack?: string
  companyDescription?: string
  brandLogoUrl?: string
  primaryColor?: string
  secondaryColor?: string
  preferredDomain?: string
  altDomain?: string
  integrationNotes?: string

  // Status, Hierarchy & Workflow
  refId?: string
  resellerId?: string
  role?: 'sub_merchant' | 'reseller' | 'super_admin'
  apiKey?: string
  balance?: {
    grossVolume: number
    netBalance: number
    totalFeesPaid: number
    pendingPayout: number
  }
  avatarUrl?: string
  currentStep: number
  applicationStatus: 'draft' | 'under_review' | 'approved' | 'rejected'

  // Processing Offer
  offer?: {
    rate: string
    volume: string
    settlement: string
    reserve: string
    setupFee?: string
    monthlyFee?: string
    isAvailable: boolean
    accepted?: boolean
    acceptedAt?: Date
    tier?: 1 | 2
    externalApplicationId?: string
  }

  // Monthly Recurring Maintenance Subscription
  subscription?: {
    status: 'active' | 'past_due' | 'canceled' | 'none'
    monthlyFee: number
    nextBillingDate?: Date
    lastBilledDate?: Date
    stripeCustomerId?: string
    paymentMethodId?: string
    autoRenew: boolean
    failureCount?: number
    gracePeriodEnd?: Date
  }

  createdAt: Date
  updatedAt: Date

  comparePassword(candidatePassword: string): Promise<boolean>
}

const MerchantSchema = new Schema<IMerchant>(
  {
    // Step 1
    fullName: { type: String, required: true, trim: true },
    businessEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    whatsapp: { type: String, trim: true },
    telegram: { type: String, trim: true },
    password: { type: String, select: false },

    // Step 2
    legalName: { type: String, trim: true },
    industry: { type: String, trim: true },
    website: { type: String, trim: true },
    yearsInBusiness: { type: String, trim: true },
    currentProcessor: { type: String, trim: true },
    monthlyVolume: { type: String, trim: true },
    avgTransaction: { type: String, trim: true },
    chargebackRate: { type: String, trim: true },
    switchReason: { type: String, trim: true },

    // Step 3
    businessRegDoc: {
      name: String,
      url: String,
      path: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    directorIdDoc: {
      name: String,
      url: String,
      path: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    processingStatementDoc: {
      name: String,
      url: String,
      path: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    agreedToTerms: { type: Boolean, default: false },

    // Website & Git Integration Setup
    websiteDomain: { type: String, trim: true },
    gitRepoUrl: { type: String, trim: true },
    setupStatus: {
      type: String,
      enum: [
        'payment_pending',
        'information_pending',
        'under_review',
        'in_development',
        'integration_testing',
        'completed',
        'delivered',
        'pending_payment',
        'paid_setup',
        'collab_submitted',
        'in_progress',
      ],
      default: 'payment_pending',
      index: true,
    },
    setupFeeAmount: { type: Number, default: 0 },
    setupPaidAt: { type: Date },
    setupStripeSessionId: { type: String, trim: true },
    gitCollabStatus: {
      type: String,
      enum: ['pending', 'invite_sent', 'accepted'],
      default: 'pending',
    },
    envConfig: { type: String, default: '' },
    affiliateCommissionEarned: { type: Number, default: 0 },

    // PRD Section 05 Onboarding Metadata
    hostingProvider: { type: String, trim: true, default: '' },
    techStack: { type: String, trim: true, default: '' },
    companyDescription: { type: String, trim: true, default: '' },
    brandLogoUrl: { type: String, trim: true, default: '' },
    primaryColor: { type: String, trim: true, default: '#D946EF' },
    secondaryColor: { type: String, trim: true, default: '#00F0FF' },
    preferredDomain: { type: String, trim: true, default: '' },
    altDomain: { type: String, trim: true, default: '' },
    integrationNotes: { type: String, trim: true, default: '' },

    // Multi-tenant & Routing
    refId: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    resellerId: {
      type: String,
      default: 'admin_root',
      index: true,
    },
    role: {
      type: String,
      enum: ['sub_merchant', 'reseller', 'super_admin'],
      default: 'sub_merchant',
    },
    apiKey: {
      type: String,
      sparse: true,
      select: false,
    },
    balance: {
      grossVolume: { type: Number, default: 0 },
      netBalance: { type: Number, default: 0 },
      totalFeesPaid: { type: Number, default: 0 },
      pendingPayout: { type: Number, default: 0 },
    },

    // Workflow
    avatarUrl: { type: String, default: '' },
    currentStep: { type: Number, default: 1, min: 1, max: 3 },
    applicationStatus: {
      type: String,
      enum: ['draft', 'under_review', 'approved', 'rejected'],
      default: 'under_review',
    },

    // Processing Offer details
    offer: {
      rate: { type: String, default: '' },
      volume: { type: String, default: '' },
      settlement: { type: String, default: '' },
      reserve: { type: String, default: '' },
      setupFee: { type: String, default: '$450' },
      monthlyFee: { type: String, default: '$99 / month' },
      isAvailable: { type: Boolean, default: false },
      accepted: { type: Boolean, default: false },
      acceptedAt: { type: Date },
      tier: { type: Number, enum: [1, 2], default: 1 },
      externalApplicationId: { type: String, trim: true, index: true, sparse: true },
    },

    // Monthly Recurring Maintenance Subscription
    subscription: {
      status: {
        type: String,
        enum: ['active', 'past_due', 'canceled', 'none'],
        default: 'none',
        index: true,
      },
      monthlyFee: { type: Number, default: 99.0 },
      nextBillingDate: { type: Date },
      lastBilledDate: { type: Date },
      stripeCustomerId: { type: String, trim: true },
      paymentMethodId: { type: String, trim: true },
      autoRenew: { type: Boolean, default: true },
      failureCount: { type: Number, default: 0 },
      gracePeriodEnd: { type: Date },
    },
  },
  {
    timestamps: true,
  }
)

// Pre-save hook: Hash password and auto-generate unique refId and apiKey
MerchantSchema.pre('save', async function (next) {
  // Generate Ref ID if absent
  if (!this.refId) {
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase()
    this.refId = `PGX_REF_${randomHex}`
  }

  // Generate API key if absent
  if (!this.apiKey) {
    this.apiKey = `pgx_live_${crypto.randomBytes(16).toString('hex')}`
  }

  // Hash password if modified
  if (!this.isModified('password') || !this.password) {
    return next()
  }

  try {
    const salt = await bcrypt.genSalt(10)
    this.password = await bcrypt.hash(this.password, salt)
    next()
  } catch (err) {
    next(err as Error)
  }
})

// Compare password method
MerchantSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  if (!this.password) return false
  return bcrypt.compare(candidatePassword, this.password)
}

export const Merchant = mongoose.model<IMerchant>('Merchant', MerchantSchema)
