---
'@adonis-agora/flags': patch
'@adonis-agora/flags-dashboard': patch
---

Console: tag, owner, key, segment, prerequisite flag, layer and layer-experiment fields are now autocomplete comboboxes (the kit's new `ComboSelect` / `ComboMultiSelect`). Tags and owners suggest the ones already in use across the flags and still take new values; the audit log's key filter suggests the keys of the entity picked.
