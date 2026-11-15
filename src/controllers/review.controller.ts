import { Request, Response, NextFunction } from 'express'
import { Review } from '../models/Review.js'
import { Merchant } from '../models/Merchant.js'
import { AdminRequest } from '../middleware/admin.middleware.js'
import { AuthRequest } from '../middleware/auth.middleware.js'

// High-Converting Initial Testimonials (English, 1 Bangladesh, 2 Spanish)
export const DEFAULT_CURATED_REVIEWS = [
  {
    authorName: 'Liam Vance',
    companyName: 'Vance Audio Labs',
    country: 'GB',
    language: 'en',
    rating: 5,
    headline: '98.4% authorization rate from day one',
    content:
      'The cloaked checkout is practically bulletproof. We went from constant processor freeze to 98.4% authorization on day one. Our Shopify store has processed six figures without a single disruption.',
    volumeProcessed: '$240K+ Processed',
    status: 'approved',
    isFeatured: true,
  },
  {
    authorName: 'Marcus Sterling',
    companyName: 'Krono Wearables',
    country: 'US',
    language: 'en',
    rating: 5,
    headline: 'Zero freeze, zero rolling reserve traps',
    content:
      'Being high-risk, we lost our Stripe accounts three times last year. With PGX Gateway turnkey bridge, payments route reliably into our multi-currency balances. The customer experience is completely seamless.',
    volumeProcessed: '$480K+ Processed',
    status: 'approved',
    isFeatured: true,
  },
  {
    authorName: 'Sophie Dubois',
    companyName: 'Luxe Cosmetics Europe',
    country: 'FR',
    language: 'en',
    rating: 5,
    headline: 'The 24h trial gave us instant proof',
    content:
      'We were hesitant to pay setup fees upfront. Being granted the 24-hour sandbox trial allowed our tech leads to test checkout sessions on our store before paying. Transparent terms and fast payout settlement.',
    volumeProcessed: '$110K+ Processed',
    status: 'approved',
    isFeatured: true,
  },
  {
    authorName: 'Ethan Chen',
    companyName: 'Vortex Gaming Assets',
    country: 'CA',
    language: 'en',
    rating: 5,
    headline: 'Cleanest API in high-risk processing',
    content:
      'HMAC webhook signatures and session initiation took less than 30 minutes to integrate using the ready Node.js snippets. By far the cleanest technical implementation in the offshore space.',
    volumeProcessed: '$320K+ Processed',
    status: 'approved',
    isFeatured: true,
  },
  {
    authorName: 'Tanvir Ahmed',
    companyName: 'Dhaka Digital Exports',
    country: 'BD',
    language: 'bn',
    headline: 'আন্তর্জাতিক কার্ড পেমেন্ট এখন একদম ঝামেলামুক্ত',
    content:
      'বাংলাদেশ থেকে ইন্টারন্যাশনাল ডিজিটাল সার্ভিস ও সফটওয়্যার এক্সপোর্টের জন্য কার্ড প্রসেসিং একটি দুঃস্বপ্ন ছিল। PGX Gateway আসার পর গ্লোবাল ক্লায়েন্টদের কার্ড পেমেন্ট সরাসরি পাওয়া যাচ্ছে কোনো একাউন্ট ব্যান ছাড়া। তাদের কাস্টমার সাপোর্ট অসাধারণ!',
    volumeProcessed: '$75K+ Processed',
    status: 'approved',
    isFeatured: true,
  },
  {
    authorName: 'Alejandro Morales',
    companyName: 'Moda Urbana Digital',
    country: 'ES',
    language: 'es',
    rating: 5,
    headline: 'Excelente pasarela para cobros internacionales',
    content:
      'Excelente pasarela para ventas internacionales. La integración con nuestro checkout fue súper rápida y los pagos con tarjeta de crédito pasan sin ningún bloqueo. Las liquidaciones son puntuales y el soporte técnico es de primera.',
    volumeProcessed: '$165K+ Processed',
    status: 'approved',
    isFeatured: true,
  },
  {
    authorName: 'Sofía Rodríguez',
    companyName: 'Nexus Software LatAm',
    country: 'MX',
    language: 'es',
    rating: 5,
    headline: 'La prueba de 24 horas nos dio total confianza',
    content:
      'Teníamos muchas dudas hasta que probamos la opción de prueba de 24 horas. Ver que los pagos entraban perfectamente y el checkout funcionaba sin fricción nos dio total tranquilidad para pagar la tarifa y activar la cuenta en vivo.',
    volumeProcessed: '$95K+ Processed',
    status: 'approved',
    isFeatured: true,
  },
]

/**
 * Public Endpoint: Fetch All Approved Testimonials for Homepage Marquee
 */
export async function getPublicReviews(req: Request, res: Response, next: NextFunction) {
  try {
    let reviews = await Review.find({ status: 'approved' }).sort({ createdAt: -1 }).lean()

    // If database has no reviews yet, automatically seed the curated multi-language reviews
    if (!reviews || reviews.length === 0) {
      await Review.insertMany(DEFAULT_CURATED_REVIEWS)
      reviews = await Review.find({ status: 'approved' }).sort({ createdAt: -1 }).lean()
    }

    return res.status(200).json({
      success: true,
      reviews,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Protected Merchant Endpoint: Submit New Testimonial from Merchant Dashboard
 */
export async function submitMerchantReview(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const merchantId = req.merchant?.id
    const { rating, headline, content, companyName, country = 'US' } = req.body

    if (!rating || !content) {
      return res.status(400).json({
        success: false,
        message: 'Rating and review content are required.',
      })
    }

    const numericRating = Math.min(5, Math.max(1, Number(rating) || 5))

    let merchantName = 'Verified Merchant'
    let merchantRefId = ''
    let resolvedCompany = companyName || 'Independent Merchant'

    if (merchantId) {
      const merchant = await Merchant.findById(merchantId)
      if (merchant) {
        merchantName = merchant.fullName || merchantName
        merchantRefId = merchant.refId || ''
        resolvedCompany = companyName || merchant.legalName || merchant.fullName || resolvedCompany
      }
    }

    const review = await Review.create({
      merchantId,
      merchantRefId,
      authorName: merchantName,
      companyName: resolvedCompany,
      country: String(country).toUpperCase().slice(0, 2),
      language: 'en',
      rating: numericRating,
      headline: headline || `${numericRating}-Star Verified Experience`,
      content: String(content).trim(),
      status: 'pending', // Requires admin approval before appearing on public landing page
      isFeatured: false,
    })

    return res.status(201).json({
      success: true,
      message: 'Thank you! Your review has been submitted and will appear on the homepage once verified by underwriting.',
      review,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Protected Admin Endpoint: List All Reviews with Filters
 */
export async function getAdminReviews(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { status } = req.query
    const filter: Record<string, unknown> = {}

    if (status && ['pending', 'approved', 'rejected'].includes(String(status))) {
      filter.status = status
    }

    const reviews = await Review.find(filter).sort({ createdAt: -1 }).lean()
    return res.status(200).json({
      success: true,
      reviews,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Protected Admin Endpoint: Approve or Reject a Review
 */
export async function updateReviewStatus(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { status, isFeatured } = req.body

    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be pending, approved, or rejected.',
      })
    }

    const updateData: Record<string, unknown> = { status }
    if (isFeatured !== undefined) {
      updateData.isFeatured = Boolean(isFeatured)
    }

    const review = await Review.findByIdAndUpdate(id, updateData, { new: true })
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found.' })
    }

    return res.status(200).json({
      success: true,
      message: `Review ${status} successfully.`,
      review,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Protected Admin Endpoint: Delete a Review
 */
export async function deleteReview(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const review = await Review.findByIdAndDelete(id)
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found.' })
    }

    return res.status(200).json({
      success: true,
      message: 'Review deleted successfully.',
    })
  } catch (error) {
    next(error)
  }
}
