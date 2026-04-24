/**
 * Throughput benchmark measurement — VictoriaMetrics counter-based completion tracking.
 *
 * Polls a PromQL counter at regular intervals to measure sustained throughput.
 * Trigger-agnostic: works with any trigger type that increments n8n_workflow_success_total.
 */
import type { TestInfo } from '@playwright/test';
import type { MetricsHelper } from 'n8n-containers';

import { attachMetric } from '../performance-helper';

// --- Types ---

export interface ThroughputSample {
	timestamp: number;
	completed: number;
	delta: number;
}

export interface ThroughputResult {
	totalCompleted: number;
	durationMs: number;
	avgExecPerSec: number;
	peakExecPerSec: number;
	actionsPerSec: number;
	peakActionsPerSec: number;
	samples: ThroughputSample[];
}

// --- PromQL queries ---

export const WORKFLOW_SUCCESS_QUERY = 'n8n_workflow_success_total';
export const QUEUE_JOBS_COMPLETED_QUERY = 'n8n_scaling_mode_queue_jobs_completed';

/**
 * Returns the completion metric for the current Playwright project.
 *
 * Currently always uses `n8n_workflow_success_total` which is emitted by both main
 * and workers, aggregated across all instances by VictoriaMetrics.
 *
 * `n8n_scaling_mode_queue_jobs_completed` is the designed queue-mode metric but
 * it depends on ScalingService.scheduleQueueMetrics() emitting `job-counts-updated`
 * events at regular intervals — currently observed as 0 in CI.
 */
export function resolveMetricQuery(_testInfo: TestInfo): string {
	return WORKFLOW_SUCCESS_QUERY;
}

// --- Throughput measurement ---

/**
 * Polls VictoriaMetrics for a completion counter until it reaches the expected count.
 * Records samples at each poll interval to calculate throughput.
 *
 * The metricQuery parameter allows switching between single-main
 * (`n8n_workflow_success_total`) and queue mode (`n8n_scaling_mode_queue_jobs_completed`).
 * For continuous generation tests, set expectedCount to Infinity and use timeoutMs as the run duration.
 */
export async function waitForThroughput(
	metrics: MetricsHelper,
	options: {
		expectedCount: number;
		nodeCount: number;
		timeoutMs: number;
		pollIntervalMs?: number;
		metricQuery?: string;
		baselineValue?: number;
		/** Break out of the poll loop if no progress is seen for this long. */
		stallThresholdMs?: number;
	},
): Promise<ThroughputResult> {
	const {
		expectedCount,
		nodeCount,
		timeoutMs,
		pollIntervalMs = 1000,
		metricQuery = WORKFLOW_SUCCESS_QUERY,
		baselineValue = 0,
		stallThresholdMs = 60_000,
	} = options;

	const samples: ThroughputSample[] = [];
	const startTime = Date.now();
	const deadline = startTime + timeoutMs;
	let lastValue = baselineValue;
	let highWaterMark = baselineValue;
	let lastProgressTime = startTime;

	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));

		let results;
		try {
			results = await metrics.query(`last_over_time(${metricQuery}[1m])`);
		} catch (error) {
			console.log(
				`[THROUGHPUT] Query error: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}

		const current = results.length > 0 ? results.reduce((sum, r) => sum + r.value, 0) : 0;

		// Monotonic guard: counters should never decrease.
		// If VictoriaMetrics returns a stale/missing value, skip this sample.
		if (current < highWaterMark) {
			console.log(
				`[THROUGHPUT] Scrape miss: counter dropped ${highWaterMark} → ${current}, skipping`,
			);
			continue;
		}

		highWaterMark = current;
		const completed = current - baselineValue;
		const delta = current - lastValue;

		samples.push({
			timestamp: Date.now(),
			completed,
			delta,
		});

		if (delta > 0) {
			console.log(`[THROUGHPUT] Completed: ${completed}/${expectedCount} (+${delta})`);
			lastProgressTime = Date.now();
		}

		lastValue = current;

		if (completed >= expectedCount) {
			break;
		}

		// Stall detection: if progress has stopped, bail early instead of waiting for full timeout.
		// Only trips after we've seen at least one non-zero delta, so we don't treat slow warm-up
		// as a stall.
		const timeSinceProgress = Date.now() - lastProgressTime;
		if (completed > 0 && timeSinceProgress > stallThresholdMs) {
			console.warn(
				`[THROUGHPUT] Stalled — no progress for ${(timeSinceProgress / 1000).toFixed(0)}s at ${completed}/${expectedCount}. Bailing early.`,
			);
			break;
		}
	}

	return calculateThroughput(samples, nodeCount, startTime);
}

/**
 * Reads the current value of the workflow success counter from VictoriaMetrics.
 * Returns 0 if the metric hasn't been scraped yet.
 */
export async function getBaselineCounter(
	metrics: MetricsHelper,
	metricQuery: string = WORKFLOW_SUCCESS_QUERY,
): Promise<number> {
	try {
		const results = await metrics.query(`last_over_time(${metricQuery}[1m])`);
		return results.length > 0 ? results.reduce((sum, r) => sum + r.value, 0) : 0;
	} catch {
		return 0;
	}
}

function calculateThroughput(
	samples: ThroughputSample[],
	nodeCount: number,
	startTime: number,
): ThroughputResult {
	if (samples.length === 0) {
		return {
			totalCompleted: 0,
			durationMs: 0,
			avgExecPerSec: 0,
			peakExecPerSec: 0,
			actionsPerSec: 0,
			peakActionsPerSec: 0,
			samples: [],
		};
	}

	// Duration measures actual processing time by excluding startup overhead AND
	// any trailing dead time after the last completion was recorded. Using the
	// last ACTIVE sample (rather than the last poll) avoids inflating the
	// denominator when the counter stalls or the run bails out early.
	const firstActiveIndex = samples.findIndex((s) => s.delta > 0);
	let lastActiveIndex = samples.length - 1;
	for (let i = samples.length - 1; i >= 0; i--) {
		if (samples[i].delta > 0) {
			lastActiveIndex = i;
			break;
		}
	}

	const firstActiveSample = firstActiveIndex >= 0 ? samples[firstActiveIndex] : samples[0];
	const lastActiveSample = samples[lastActiveIndex];

	// Skip the warm-up window so reported throughput reflects sustained behavior,
	// not V8 JIT / PG pool fill / Kafka consumer ramp-up. We look for the first
	// sample whose timestamp is >= firstActive + WARMUP_MS and anchor the
	// measurement there. If the run is too short to have a post-warmup window
	// (<= 2x warmup), fall back to measuring from first-active (old behavior)
	// and flag it in logs so short-run numbers remain interpretable.
	const WARMUP_MS = 30_000;
	const activeSpanMs = lastActiveSample.timestamp - firstActiveSample.timestamp;
	const useWarmupSkip = activeSpanMs >= 2 * WARMUP_MS;

	let measurementStartIndex = firstActiveIndex >= 0 ? firstActiveIndex : 0;
	if (useWarmupSkip) {
		const warmupDeadline = firstActiveSample.timestamp + WARMUP_MS;
		const postWarmupIndex = samples.findIndex(
			(s, i) => i >= measurementStartIndex && s.timestamp >= warmupDeadline,
		);
		if (postWarmupIndex !== -1 && postWarmupIndex <= lastActiveIndex) {
			measurementStartIndex = postWarmupIndex;
		}
	} else if (firstActiveIndex >= 0) {
		console.log(
			`[THROUGHPUT] Run too short (${(activeSpanMs / 1000).toFixed(1)}s) to exclude warm-up; reporting includes ramp-up period`,
		);
	}

	const measurementStartSample = samples[measurementStartIndex];
	const referenceStart =
		measurementStartIndex > 0
			? samples[measurementStartIndex - 1].timestamp
			: firstActiveIndex > 0
				? samples[firstActiveIndex - 1].timestamp
				: startTime;

	const totalCompleted = lastActiveSample.completed;
	const measuredCompleted =
		lastActiveSample.completed - measurementStartSample.completed + measurementStartSample.delta;
	const durationMs = lastActiveSample.timestamp - referenceStart;

	// Peak rate intentionally omitted: at current poll/scrape cadence, a single
	// poll interval can catch a full 15s scrape batch worth of completions,
	// inflating "peak" by an order of magnitude. Reporting it is more misleading
	// than useful.
	const avgExecPerSec = durationMs > 0 ? (measuredCompleted / durationMs) * 1000 : 0;

	return {
		totalCompleted,
		durationMs,
		avgExecPerSec,
		peakExecPerSec: 0,
		actionsPerSec: avgExecPerSec * nodeCount,
		peakActionsPerSec: 0,
		samples,
	};
}

// --- Result reporting ---

export async function attachThroughputResults(
	testInfo: TestInfo,
	dimensions: Record<string, string | number>,
	result: ThroughputResult,
): Promise<void> {
	await attachMetric(testInfo, 'exec-per-sec', result.avgExecPerSec, 'exec/s', dimensions);
	await attachMetric(testInfo, 'actions-per-sec', result.actionsPerSec, 'actions/s', dimensions);
	await attachMetric(testInfo, 'total-completed', result.totalCompleted, 'count', dimensions);
	await attachMetric(testInfo, 'duration', result.durationMs, 'ms', dimensions);
}
