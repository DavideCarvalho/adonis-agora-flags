export const VERSION = '0.0.0';

export { BUCKET_COUNT, bucketOf, murmur3, pickVariant } from './bucket.js';
export {
  compareSemver,
  type EvaluationContext,
  type EvaluationDetails,
  type EvaluationErrorCode,
  type EvaluationReason,
  evaluate,
  type FlagMetadata,
} from './evaluate.js';
export {
  type AttributeCondition,
  type Condition,
  type ConditionValue,
  emptyRuleset,
  type FlagDefinition,
  type JsonValue,
  OPERATORS,
  type Operator,
  type Prerequisite,
  RULESET_SCHEMA_VERSION,
  type Ruleset,
  type Segment,
  type SegmentCondition,
  type Serve,
  type TargetingRule,
  type WeightedVariant,
} from './ruleset.js';
export {
  type ConversionCounts,
  chiSquareSf,
  normalCdf,
  normalQuantile,
  normalSf,
  type ProportionTestResult,
  proportionTest,
  type SrmResult,
  type SufficientStats,
  type Summary,
  srmTest,
  studentTCdf,
  studentTQuantile,
  studentTTwoSided,
  summarize,
  type WelchTestResult,
  welchTest,
} from './stats.js';
export { type RulesetIssue, validateRuleset } from './validate.js';
