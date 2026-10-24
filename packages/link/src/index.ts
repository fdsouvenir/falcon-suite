import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { contract } from './contract.js';
import { overview } from './status.js';

export default defineFeaturePlugin({
	contract,
	name: 'Falcon Link',
	description: 'Connect and maintain known integrations.',
	setup() {
		return { status: () => overview() };
	}
});
