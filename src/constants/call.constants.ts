export const CALL_TYPES = ['voice', 'video'] as const;
export const CALL_STATUSES = ['initiated', 'ringing', 'connecting', 'active', 'ended', 'declined', 'missed', 'failed'] as const;
export const CALL_END_REASONS = ['normal', 'declined', 'missed', 'failed', 'network_error', 'cancelled', 'timeout'] as const;
export const CALL_QUALITIES = ['excellent', 'good', 'poor', 'failed'] as const;
export const CALL_CONNECTION_TYPES = ['wifi', 'cellular', 'unknown'] as const;
