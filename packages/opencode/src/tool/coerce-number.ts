import { Schema } from "effect"

/**
 * Accepts a number or a numeric string and decodes to number.
 *
 * Workaround for upstream commit 3910a6e5 (PR #23244) which removed the
 * z.coerce.number() tolerance. Claude Opus occasionally stringifies numeric
 * tool inputs (e.g. offset: "268"); without this helper the SDK rejects
 * those tool_use blocks and burns Meridian's passthrough turn budget.
 */
export const NumberCoerce = Schema.Union([Schema.Number, Schema.NumberFromString])
export const PositiveIntCoerce = NumberCoerce.check(Schema.isInt()).check(Schema.isGreaterThan(0))
export const NonNegativeIntCoerce = NumberCoerce.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))
