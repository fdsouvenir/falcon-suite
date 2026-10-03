import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { contract } from './contract.js';

export default defineFeaturePlugin({
	contract,
	name: 'Falcon Work',
	description: 'A record of what your agents do, why, and what needs you.',
	setup() {
		return {};
	}
});
