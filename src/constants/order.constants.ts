export const ORDER_PAYMENT_STATUSES = ['pending', 'paid', 'held', 'released', 'refunded', 'failed'] as const;
export const ORDER_STATUSES = ['created', 'payment_pending', 'payment_received', 'processing', 'shipped', 'delivered', 'confirmed', 'disputed', 'cancelled', 'refunded', 'seller_rejected'] as const;
export const ORDER_DISPUTE_REASONS = ['damaged_product', 'wrong_item', 'missing_item', 'not_as_described', 'defective', 'counterfeit', 'other'] as const;
export const ORDER_DISPUTE_STATUSES = ['open', 'under_review', 'resolved', 'rejected'] as const;
export const ORDER_SELLER_RESPONSE_STATUSES = ['confirmed', 'rejected'] as const;
export const ORDER_SELLER_REJECTION_REASONS = ['out_of_stock', 'price_change', 'invalid_address', 'need_clarification', 'certificate_required', 'other'] as const;
