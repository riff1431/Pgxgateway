import mongoose, { Document, Schema } from 'mongoose'

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
    size?: string
    uploadedAt: Date
  }
  directorIdDoc?: {
    name: string
    url?: string
    size?: string
    uploadedAt: Date
  }
  processingStatementDoc?: {
    name: string
    url?: string
    size?: string
    uploadedAt: Date
  }
  agreedToTerms: boolean

  // Status & Workflow
  currentStep: number
  applicationStatus: 'draft' | 'under_review' | 'approved' | 'rejected'

  // Processing Offer
  offer?: {
    rate: string
    volume: string
    settlement: string
    reserve: string
    isAvailable: boolean
  }

  createdAt: Date
  updatedAt: Date
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
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    directorIdDoc: {
      name: String,
      url: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    processingStatementDoc: {
      name: String,
      url: String,
      size: String,
      uploadedAt: { type: Date, default: Date.now },
    },
    agreedToTerms: { type: Boolean, default: false },

    // Workflow
    currentStep: { type: Number, default: 1, min: 1, max: 3 },
    applicationStatus: {
      type: String,
      enum: ['draft', 'under_review', 'approved', 'rejected'],
      default: 'under_review',
    },

    // Processing Offer details
    offer: {
      rate: { type: String, default: '2.9% + $0.30' },
      volume: { type: String, default: 'Up to $250,000' },
      settlement: { type: String, default: 'Daily (Next Day)' },
      reserve: { type: String, default: '5% (90 Days)' },
      isAvailable: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
  }
)

export const Merchant = mongoose.model<IMerchant>('Merchant', MerchantSchema)
