import { ListLoader } from '@adonisjs/core/ace';
import FlagsList from './flags_list.js';
import {
  FlagsExport,
  FlagsForget,
  FlagsImport,
  FlagsPromote,
  FlagsReplay,
  FlagsRequests,
  FlagsResults,
  FlagsStale,
} from './flags_ops.js';
import FlagsRefs from './flags_refs.js';
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
  FlagsResults,
  FlagsRefs,
  FlagsForget,
  FlagsReplay,
  FlagsRequests,
  FlagsTypes,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
