// The plugin's identity, the same on every release channel (preview and production are tags on one
// ClawHub listing). The database location is fixed by the spec (§3), not derived from the id.
export const PLUGIN_ID = 'falcon-vault';
// Release staging (scripts/stage.mjs) replaces this with the published package version.
export const PLUGIN_VERSION = '5.0.0-dev.0';
