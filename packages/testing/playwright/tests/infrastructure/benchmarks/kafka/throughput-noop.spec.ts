import { test } from '../../../../fixtures/base';
import {
	BENCHMARK_MAIN_RESOURCES,
	BENCHMARK_WORKER_RESOURCES,
} from '../../../../playwright-projects';
import { kafkaDriver } from '../../../../utils/benchmark';
import { runThroughputTest } from '../harness/throughput-harness';

const envMessages = parseInt(process.env.BENCHMARK_MESSAGES ?? '0', 10);

test.use({ capability: { env: { TEST_ISOLATION: 'kafka-tp-noop' } } });

test.describe(
	'Kafka Throughput: trigger -> noop',
	{
		annotation: [{ type: 'owner', description: 'Catalysts' }],
	},
	() => {
		test('trigger + 1 noop, 1KB payload, 5000 msgs', async ({ api, services }, testInfo) => {
			const handle = await kafkaDriver.setup({
				api,
				services,
				scenario: { nodeCount: 1, payloadSize: '1KB', nodeOutputSize: 'noop', partitions: 3 },
			});
			await runThroughputTest({
				handle,
				api,
				services,
				testInfo,
				messageCount: envMessages || 5_000,
				nodeCount: 1,
				nodeOutputSize: 'noop',
				trigger: 'kafka',
				timeoutMs: 900_000,
				plan: BENCHMARK_MAIN_RESOURCES,
				workerPlan: BENCHMARK_WORKER_RESOURCES,
			});
		});
	},
);
