/** What an export job gets to run with. */
export interface ExportJob {
	/** Aborts when the job is cancelled or another export supersedes it. */
	signal: AbortSignal;
	/** False once another export has started; a superseded job's progress is stale. */
	isCurrent: () => boolean;
}

/**
 * Runs exports one at a time. Every export draws on the compositor's one
 * canvas, so a new export cancels the one before it and waits for it to finish
 * cleaning up before it starts drawing.
 */
export class ExportJobs {
	private current: AbortController | null = null;
	private running = 0;
	/** Settles once the most recently started job, and so every job, has finished. */
	private settled: Promise<void> = Promise.resolve();

	/** Whether any export, a cancelled one too, still holds the compositor. */
	isRunning(): boolean {
		return this.running > 0;
	}

	cancel(): void {
		this.current?.abort();
	}

	/**
	 * Cancels the current export and runs `run` once every earlier one has
	 * finished. `superseded` says another export started before this one ended.
	 */
	async start<T>({
		run,
	}: {
		run: (job: ExportJob) => Promise<T>;
	}): Promise<{ result: T; superseded: boolean }> {
		this.current?.abort();
		const controller = new AbortController();
		this.current = controller;
		const isCurrent = () => this.current === controller;

		const previous = this.settled;
		let release = () => {};
		this.settled = new Promise((resolve) => {
			release = resolve;
		});
		this.running++;
		try {
			await previous;
			const result = await run({ signal: controller.signal, isCurrent });
			return { result, superseded: !isCurrent() };
		} finally {
			if (isCurrent()) this.current = null;
			this.running--;
			release();
		}
	}
}
