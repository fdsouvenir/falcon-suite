// The plugin's identity. Production is `falcon-work`; scripts/stage.mjs rewrites this one line for
// the preview channel (`falcon-work-preview`), so the two can never share an id or a data directory.
export const PLUGIN_ID = 'falcon-work';
