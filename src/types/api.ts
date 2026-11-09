/**
 * Global standardized API response structures
 */

export interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
  error?: string
}

export interface PaginatedResponse<T = unknown> extends ApiResponse<T[]> {
  total: number
  page: number
  limit: number
  totalPages: number
}
