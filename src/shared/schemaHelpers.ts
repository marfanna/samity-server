import { SchemaTypeOptions } from 'mongoose';

/**
 * Shared field builders. ALL money is integer paisa (1 BDT = 100 paisa).
 * Mirrors `docs/6. Database Schema - Samity.md` § Conventions.
 */

const integer = { validator: Number.isInteger, message: '{PATH} must be an integer' } as const;
const integerPaisa = { validator: Number.isInteger, message: '{PATH} must be integer paisa' } as const;

/** Non-negative integer paisa (balances, amounts that can't go negative). */
export function paisa(extra: Partial<SchemaTypeOptions<number>> = {}): SchemaTypeOptions<number> {
  return { type: Number, validate: integerPaisa, min: 0, ...extra };
}

/** Signed integer paisa (ledger entries, deltas). */
export function signedPaisa(extra: Partial<SchemaTypeOptions<number>> = {}): SchemaTypeOptions<number> {
  return { type: Number, validate: integerPaisa, ...extra };
}

/** Non-negative integer count (shares, cycles). */
export function intCount(extra: Partial<SchemaTypeOptions<number>> = {}): SchemaTypeOptions<number> {
  return { type: Number, validate: integer, min: 0, ...extra };
}

/** Signed integer count (share deltas in the ledger). */
export function signedInt(extra: Partial<SchemaTypeOptions<number>> = {}): SchemaTypeOptions<number> {
  return { type: Number, validate: integer, ...extra };
}

/** Standard options: createdAt/updatedAt, no __v. Append-only docs override with their own `at`. */
export const baseOpts = { timestamps: true, versionKey: false } as const;

/** Append-only options: immutable `at`, no timestamps, no __v. */
export const appendOnlyOpts = { versionKey: false } as const;
