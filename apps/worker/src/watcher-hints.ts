import chokidar from 'chokidar';

type HintWatcher = {
  on: (event: string, listener: (...args: any[]) => void) => HintWatcher;
  close: () => Promise<void>;
};

/** Event paths are intentionally discarded: hints only request a complete configured root scan. */
export function startWatcherHints(
  deps: Readonly<{
    roots: ReadonlyMap<string, { canonicalPath: string }>;
    enabled: boolean;
    debounceMs: number;
    request: (rootId: string) => Promise<void>;
    log: { error: (data: object, message: string) => void };
    watchFactory?: (paths: readonly string[]) => HintWatcher;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }>,
): { close: () => Promise<void> } {
  if (!deps.enabled || deps.roots.size === 0) return { close: async () => undefined };
  const roots = [...deps.roots.entries()];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const hint = (path: string | undefined) => {
    if (!path) return;
    const root = roots.find(
      ([, candidate]) =>
        path === candidate.canonicalPath || path.startsWith(`${candidate.canonicalPath}/`),
    );
    if (!root || timers.has(root[0])) return;
    timers.set(
      root[0],
      setTimer(() => {
        timers.delete(root[0]);
        void deps
          .request(root[0])
          .catch(() => deps.log.error({ code: 'WATCHER_HINT_FAILED' }, 'watcher hint failed'));
      }, deps.debounceMs),
    );
  };
  let watcher: HintWatcher;
  try {
    watcher = deps.watchFactory
      ? deps.watchFactory(roots.map(([, root]) => root.canonicalPath))
      : (chokidar.watch(
          roots.map(([, root]) => root.canonicalPath),
          {
            ignoreInitial: true,
            persistent: true,
            followSymlinks: false,
          },
        ) as unknown as HintWatcher);
  } catch {
    deps.log.error(
      { code: 'WATCHER_START_FAILED' },
      'watcher hint unavailable; periodic reconciliation continues',
    );
    return { close: async () => undefined };
  }
  watcher
    .on('add', hint)
    .on('change', hint)
    .on('unlink', hint)
    .on('addDir', hint)
    .on('unlinkDir', hint)
    .on('error', () =>
      deps.log.error(
        { code: 'WATCHER_FAILED' },
        'watcher hint unavailable; periodic reconciliation continues',
      ),
    );
  return {
    close: async () => {
      for (const timer of timers.values()) clearTimer(timer);
      await watcher
        .close()
        .catch(() => deps.log.error({ code: 'WATCHER_CLOSE_FAILED' }, 'watcher hint close failed'));
    },
  };
}
