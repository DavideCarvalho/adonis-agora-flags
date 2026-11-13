import { ListLoader } from '@adonisjs/core/ace';
import {
  FlagsAuditList,
  FlagsEnvironmentsList,
  FlagsExperimentsList,
  FlagsExperimentsRecompute,
  FlagsExperimentsShow,
  FlagsOpsStatus,
  FlagsRequestsApprove,
  FlagsRequestsCancel,
  FlagsRequestsList,
  FlagsRequestsReject,
  FlagsSchedulesCancel,
  FlagsSchedulesCreate,
  FlagsSchedulesList,
} from './flags_activity.js';
import {
  FlagsFlagCreate,
  FlagsFlagDelete,
  FlagsFlagDisable,
  FlagsFlagEnable,
  FlagsFlagEvaluate,
  FlagsFlagOverride,
  FlagsFlagRollout,
  FlagsFlagSave,
  FlagsFlagShow,
  FlagsFlagUpdate,
  FlagsFlagVariant,
} from './flags_flag.js';
import FlagsList from './flags_list.js';
import {
  FlagsExport,
  FlagsForget,
  FlagsImport,
  FlagsPromote,
  FlagsReplay,
  FlagsStale,
} from './flags_ops.js';
import FlagsRefs from './flags_refs.js';
import {
  FlagsHoldoutSave,
  FlagsLayersDelete,
  FlagsLayersList,
  FlagsLayersSave,
  FlagsMetricsDelete,
  FlagsMetricsList,
  FlagsMetricsSave,
  FlagsSegmentsDelete,
  FlagsSegmentsList,
  FlagsSegmentsSave,
} from './flags_ruleset.js';
import FlagsSet from './flags_set.js';
import FlagsTypes from './flags_types.js';
import FlagsWork from './flags_work.js';

/**
 * The commands of `@adonis-agora/flags`, registered by `configure` with
 * `rcFile.addCommand('@adonis-agora/flags/commands')`.
 */
const loader = new ListLoader([
  FlagsList,
  FlagsSet,
  FlagsWork,
  FlagsExport,
  FlagsImport,
  FlagsPromote,
  FlagsStale,
  FlagsRefs,
  FlagsForget,
  FlagsReplay,
  FlagsTypes,
  FlagsFlagShow,
  FlagsFlagEnable,
  FlagsFlagDisable,
  FlagsFlagRollout,
  FlagsFlagVariant,
  FlagsFlagOverride,
  FlagsFlagSave,
  FlagsFlagCreate,
  FlagsFlagUpdate,
  FlagsFlagDelete,
  FlagsFlagEvaluate,
  FlagsSegmentsList,
  FlagsSegmentsSave,
  FlagsSegmentsDelete,
  FlagsLayersList,
  FlagsLayersSave,
  FlagsLayersDelete,
  FlagsHoldoutSave,
  FlagsMetricsList,
  FlagsMetricsSave,
  FlagsMetricsDelete,
  FlagsExperimentsList,
  FlagsExperimentsShow,
  FlagsExperimentsRecompute,
  FlagsRequestsList,
  FlagsRequestsApprove,
  FlagsRequestsReject,
  FlagsRequestsCancel,
  FlagsSchedulesList,
  FlagsSchedulesCreate,
  FlagsSchedulesCancel,
  FlagsAuditList,
  FlagsEnvironmentsList,
  FlagsOpsStatus,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
