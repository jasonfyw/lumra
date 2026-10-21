import { BYTES_PER_GB } from './limits';

/**
 * Launch rate card (PRD §9.2). Money is integer micro-USD (1 USD = 1_000_000).
 * Only `monthlyFeeMicroUsd` for Pro is a confirmed decision; the rest are Proposed
 * and must be validated against unit economics before live billing (PRD §17).
 * The authoritative copy will live in the `plans` table (T27); this is the seed/default.
 */
export const MICRO_USD_PER_USD = 1_000_000;

export type PlanId = 'free' | 'pro';

export interface PlanRates {
  id: PlanId;
  rateVersion: number;
  monthlyFeeMicroUsd: number;
  maxActiveGalleries: number | null;
  /** Hard storage cap in bytes (Free only). */
  maxStorageBytes: number | null;
  /** Hard monthly delivery cap in bytes (Free only). */
  maxDeliveryBytesPerMonth: number | null;
  includedStorageGbMonth: number;
  includedDeliveryGb: number;
  storageOverageMicroUsdPerGbMonth: number | null;
  deliveryOverageMicroUsdPerGb: number | null;
  defaultOverageCapMicroUsd: number | null;
  brandingVisible: boolean;
}

export const RATE_CARD_V1: Record<PlanId, PlanRates> = {
  free: {
    id: 'free',
    rateVersion: 1,
    monthlyFeeMicroUsd: 0,
    maxActiveGalleries: 2,
    maxStorageBytes: 1 * BYTES_PER_GB,
    maxDeliveryBytesPerMonth: 3 * BYTES_PER_GB,
    includedStorageGbMonth: 0,
    includedDeliveryGb: 0,
    storageOverageMicroUsdPerGbMonth: null,
    deliveryOverageMicroUsdPerGb: null,
    defaultOverageCapMicroUsd: null,
    brandingVisible: true,
  },
  pro: {
    id: 'pro',
    rateVersion: 1,
    monthlyFeeMicroUsd: 2 * MICRO_USD_PER_USD,
    maxActiveGalleries: null,
    maxStorageBytes: null,
    maxDeliveryBytesPerMonth: null,
    includedStorageGbMonth: 2,
    includedDeliveryGb: 5,
    storageOverageMicroUsdPerGbMonth: 100_000, // $0.10
    deliveryOverageMicroUsdPerGb: 30_000, // $0.03
    defaultOverageCapMicroUsd: 10 * MICRO_USD_PER_USD,
    brandingVisible: false,
  },
};
