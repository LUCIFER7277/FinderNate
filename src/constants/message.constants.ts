export const MESSAGE_TYPES = ['text', 'image', 'video', 'file', 'audio', 'location', 'payment_link', 'checkout', 'order_update'] as const;
export const MESSAGE_DELIVERY_STATUSES = ['sent', 'delivered', 'seen'] as const;
export const MESSAGE_CHECKOUT_STATUSES = ['pending', 'paid', 'expired'] as const;
export const MESSAGE_PRODUCT_TYPES = ['product', 'service', 'business'] as const;
