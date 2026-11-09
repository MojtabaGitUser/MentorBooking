export const movementLabels = {
  PURCHASE_GRANT: 'Pack purchase',
  BOOKING_DEBIT: 'Session booked',
  CANCELLATION_REFUND: 'Cancellation refund',
  MENTOR_REFUND: 'Mentor cancellation refund',
  NO_SHOW_ROLLOVER: 'Mentor no-show award',
  ROLLOVER_EXPIRE: 'Rollover expired',
  ADMIN_GRANT: 'Admin grant',
  ADMIN_REVOKE: 'Admin revocation',
  PAYMENT_REVERSAL: 'Payment reversal',
  DEBT: 'Payment debt',
} as const;

export interface CreditMovement {
  id: string;
  kind: keyof typeof movementLabels;
  delta: number;
  creditType: 'NORMAL' | 'ROLLOVER';
  expiresAt: string | null;
}
export interface LedgerRow extends CreditMovement {
  createdAt: string;
  reason: string | null;
  sessionId: string | null;
  paymentId: string | null;
  adjustmentId: string | null;
  lotId: string;
}
export interface LedgerPage {
  items: LedgerRow[];
  nextCursor: string | null;
}
export interface Wallet {
  totalSpendable: number;
  normal: number;
  rollover: number;
  debt: number;
  rolloverLots: { lotId: string; remaining: number; expiresAt: string }[];
  history: LedgerPage;
  lastRolloverExpiry?: string;
}
export interface Purchase {
  paymentId: string;
  providerPaymentId: string;
  packCredits: number;
  status: 'PENDING' | 'SUCCEEDED' | 'REFUNDED';
  createdAt: string;
}

export function creditDelta(delta: number) {
  return (delta > 0 ? '+' : '') + delta + (Math.abs(delta) === 1 ? ' credit' : ' credits');
}

export function walletTime(iso: string, zone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  }).format(new Date(iso));
}
export const sessionLabels: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show_mentor: 'Mentor no-show',
  no_show_mentee: 'Mentee no-show',
};
