/**
 * ClawcalAdapter — shape type for the Clawcal provider adapter.
 *
 * The driver model ({@link ../Drivers/ClawcalDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module ClawcalAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClawcalAdapterShape — per-instance Clawcal adapter contract.
 */
export interface ClawcalAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
