// The plugin's identity. Production is `falcon-vault`; a preview channel rewrites this one line
// (scripts/stage.mjs), so the two can never share an id. They do share the database: its location
// is fixed by the spec (§3), not derived from the id.
export const PLUGIN_ID = 'falcon-vault';
// Release staging replaces this with the published package version.
export const PLUGIN_VERSION = '5.0.0-dev.0';
