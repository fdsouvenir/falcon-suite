// The plugin's identity. Production is `falcon-work`; scripts/stage.mjs rewrites this one line for
// the preview channel (`falcon-work-preview`), so the two can never share an id or a data directory.
export const PLUGIN_ID = 'falcon-work';
// Release staging replaces this with the published package version.
export const PLUGIN_VERSION = '5.0.0-dev.0';
