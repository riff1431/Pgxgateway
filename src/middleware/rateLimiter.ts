import rateLimit from 'express-rate-limit'

/**
 * Strict rate limiter for Authentication endpoints (prevents brute-force attacks)
 * Allows up to 15 login/register attempts per 15 minutes per client IP
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 requests per window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.',
  },
})

/**
 * General API rate limiter to protect server resources from abusive traffic / DoS
 * Allows up to 300 requests per 15 minutes per client IP
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP. Please try again later.',
  },
})
