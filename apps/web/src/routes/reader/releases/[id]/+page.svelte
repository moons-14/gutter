<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { currentDestination, loginHref, session } from '$lib/session';
  import {
    canMove, defaultPresentation, gestureStep, loadPresentation, loadProgress, move,
    foregroundResourceKeys, pagePosition, PageResourceScheduler, retainedResourceKeys, savePresentation,
    saveProgress, setPresentation, storeNextHandoff, takeNextHandoff, visibleOrdinals,
    type ReaderDescriptor, type ReaderState,
  } from '$lib/reader';

  export let data: { id: string };
  export let publication = false;
  let state: ReaderState | null = null;
  let error = '';
  let errorKind: 'access' | 'missing' | 'empty' | 'unavailable' | 'failure' = 'failure';
  let pageError: number | null = null;
  let resourceVersion = 0;
  let scheduler: PageResourceScheduler | null = null;
  let refreshedDescriptor = false;
  let refreshingDescriptor = false;
  let direction: -1 | 1 = 1;
  let nextSession: { releaseId: string; ordinal: number } | null = null;
  let nextTransferred = false;
  let incomingHandoff: ReturnType<typeof takeNextHandoff> = null;
  let showResume = false;
  let resumeDialog: HTMLElement;
  let resumePrimary: HTMLButtonElement;
  let resumeFocusOrigin: HTMLElement | null = null;
  let startX: number | null = null;
  let pendingResume: number | null = null;
  let pointerTapReady = false;
  let suppressPointerTap = false;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerDoubleTapCandidate = false;
  let reader: HTMLElement;
  let fullscreen = false;
  let fullscreenError = '';
  let remoteLoaded = false;
  let remoteRevision = 0;
  let lastRemoteOrdinal: number | null = null;
  let remoteStatus = '';
  let remoteError = '';
  let bookmarkStatus = '';
  let bookmarkError = '';
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let remoteLoadGeneration = -1;
  let remoteAbortController: AbortController | null = null;
  let remotePutAbortController: AbortController | null = null;
  let descriptorGeneration = 0;
  let explicitResumeRequested = false;
  let explicitResumeOrdinal: number | null = null;
  const visibility = new Map<number, number>();
  const validReleaseId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
  const requestedResumeOrdinal = (
    descriptor: ReaderDescriptor,
  ): { present: boolean; ordinal: number | null } => {
    if (typeof window === 'undefined') return { present: false, ordinal: null };
    const params = new URLSearchParams(window.location.search);
    if (!params.has('resume')) return { present: false, ordinal: null };
    const raw = params.get('resume') ?? '';
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return { present: true, ordinal: null };
    const ordinal = Number(raw);
    return {
      present: true,
      ordinal:
        Number.isSafeInteger(ordinal) && descriptor.validOrdinals.includes(ordinal) ? ordinal : null,
    };
  };
  function setResumeVisible(next: boolean) {
    if (next && !showResume && typeof document !== 'undefined') resumeFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    showResume = next;
    if (next) setTimeout(() => resumePrimary?.focus(), 0);
  }
  $: if (showResume) void focusResume();

  async function loadDescriptor(refresh = false) {
    const generation = ++descriptorGeneration;
    remoteAbortController?.abort();
    remoteAbortController = null;
    remotePutAbortController?.abort();
    remotePutAbortController = null;
    remoteLoadGeneration = -1;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    try {
      error = '';
      errorKind = 'failure';
      nextSession = null;
      nextTransferred = false;
      const response = await fetch(
        publication ? `/api/reader/publications/${data.id}` : `/api/reader/releases/${data.id}`,
        { cache: 'no-store' },
      );
      const body = (await response.json().catch(() => ({}))) as { release?: ReaderDescriptor | null; session?: { releaseId: string; release: ReaderDescriptor } | null };
      const releaseId = publication ? body.session?.releaseId : data.id;
      const descriptor = publication ? body.session?.release : body.release;
      if (!response.ok) {
        errorKind = response.status === 401 || response.status === 403 ? 'access' : response.status === 404 ? 'missing' : 'unavailable';
        throw new Error('reader_unavailable');
      }
      if (!validReleaseId(releaseId) || !descriptor) { errorKind = 'missing'; throw new Error('reader_missing'); }
      if (descriptor.validOrdinals.length === 0) { errorKind = 'empty'; throw new Error('reader_empty'); }
      const requestedResume = requestedResumeOrdinal(descriptor);
      explicitResumeRequested = requestedResume.present;
      explicitResumeOrdinal = requestedResume.ordinal;
      const saved = refresh || explicitResumeRequested ? null : loadProgress(descriptor);
      state = {
        releaseId,
        descriptor,
        ordinal: explicitResumeOrdinal ?? descriptor.validOrdinals[0]!,
        presentation: loadPresentation(),
        persistProgress: saved === null || explicitResumeRequested,
      };
      incomingHandoff = publication ? takeNextHandoff(data.id) : null;
      if (incomingHandoff && (incomingHandoff.releaseId !== releaseId || incomingHandoff.ordinal !== state.ordinal)) {
        URL.revokeObjectURL(incomingHandoff.resource.url);
        incomingHandoff = null;
      }
      pendingResume = explicitResumeRequested ? null : saved;
      setResumeVisible(!explicitResumeRequested && saved !== null && saved !== state.ordinal);
      remoteLoaded = false;
      remoteStatus = '';
      remoteError = '';
      void loadRemoteProgress(generation);
    } catch {
      error = errorKind === 'access' ? 'このリリースへのアクセスが許可されていません。' : errorKind === 'missing' ? 'このリリースは見つからないか、現在利用できません。' : errorKind === 'empty' ? '読めるページがありません。' : 'このリリースは現在利用できません。ネットワークやライブラリの状態を確認してください。';
    } finally {
      refreshingDescriptor = false;
    }
  }

  onMount(() => { void loadDescriptor(); });
  onDestroy(() => {
    scheduler?.clear();
    remoteAbortController?.abort();
    remotePutAbortController?.abort();
    if (tapTimer) clearTimeout(tapTimer);
    if (progressTimer) clearTimeout(progressTimer);
  });

  async function loadRemoteProgress(generation = descriptorGeneration) {
    const currentSession = get(session);
    if (generation !== descriptorGeneration || !state || currentSession.loading || !currentSession.user || remoteLoaded || remoteLoadGeneration === generation) return;
    remoteLoadGeneration = generation;
    const descriptor = state.descriptor;
    const controller = new AbortController();
    remoteAbortController = controller;
    try {
      const response = await fetch(`/api/user-state/progress?rootId=${encodeURIComponent(descriptor.rootId)}&progressKey=${encodeURIComponent(descriptor.progressKey)}`, { signal: controller.signal });
      if (generation !== descriptorGeneration || state?.descriptor !== descriptor) return;
      if (response.status === 401) {
        remoteError = 'ログインすると読書位置を同期できます。';
        return;
      }
      if (!response.ok) throw new Error('remote_progress_unavailable');
      const body = await response.json() as { progress?: { revision?: unknown; pageOrdinal?: unknown } | null };
      const progress = body.progress;
      const revision = progress && typeof progress.revision === 'number' && Number.isInteger(progress.revision) && progress.revision >= 0 ? progress.revision : 0;
      remoteRevision = revision;
      const ordinal = progress?.pageOrdinal;
      const remoteOrdinal = typeof ordinal === 'number' && Number.isInteger(ordinal) && descriptor.validOrdinals.includes(ordinal) ? ordinal : null;
      if (remoteOrdinal !== null) {
        pendingResume = explicitResumeRequested ? null : remoteOrdinal;
        setResumeVisible(!explicitResumeRequested && remoteOrdinal !== state.ordinal);
        state = { ...state, persistProgress: true };
      }
      lastRemoteOrdinal = explicitResumeRequested && remoteOrdinal !== null ? remoteOrdinal : state.ordinal;
      remoteLoaded = true;
    } catch {
      if (generation === descriptorGeneration && !controller.signal.aborted) remoteError = '読書位置を同期できませんでした。';
    } finally {
      if (remoteAbortController === controller) remoteAbortController = null;
    }
  }

  async function putRemoteProgress(ordinal: number) {
    const currentSession = get(session);
    if (!remoteLoaded || !currentSession.user || !state || !state.descriptor.validOrdinals.includes(ordinal)) return;
    const generation = descriptorGeneration;
    const descriptor = state.descriptor;
    const controller = new AbortController();
    remotePutAbortController?.abort();
    remotePutAbortController = controller;
    try {
      const response = await fetch('/api/user-state/progress', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootId: descriptor.rootId, progressKey: descriptor.progressKey, expectedRevision: remoteRevision, pageOrdinal: ordinal, completed: ordinal === descriptor.validOrdinals.at(-1) }),
        signal: controller.signal,
      });
      if (generation !== descriptorGeneration || state?.descriptor !== descriptor) return;
      const body = await response.json().catch(() => ({})) as { progress?: { revision?: unknown; pageOrdinal?: unknown } | null };
      if (response.status === 200 && body.progress && typeof body.progress.revision === 'number') {
        remoteRevision = body.progress.revision;
        lastRemoteOrdinal = ordinal;
        remoteError = '';
      } else if (response.status === 409 && body.progress) {
        const progress = body.progress;
        if (typeof progress.revision === 'number') remoteRevision = progress.revision;
        if (typeof progress.pageOrdinal === 'number' && descriptor.validOrdinals.includes(progress.pageOrdinal)) {
          pendingResume = progress.pageOrdinal;
          setResumeVisible(progress.pageOrdinal !== state.ordinal);
        }
        remoteStatus = 'サーバー側の読書位置を採用しました。';
        lastRemoteOrdinal = state.ordinal;
      } else if (response.status === 401) remoteError = 'ログインすると読書位置を同期できます。';
      else remoteError = '読書位置を同期できませんでした。';
    } catch {
      if (generation === descriptorGeneration && !controller.signal.aborted) remoteError = '読書位置を同期できませんでした。';
    } finally {
      if (remotePutAbortController === controller) remotePutAbortController = null;
    }
  }

  async function addBookmark() {
    if (!state || !get(session).user) return;
    bookmarkStatus = ''; bookmarkError = '';
    try {
      const response = await fetch('/api/user-state/bookmarks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootId: state.descriptor.rootId, progressKey: state.descriptor.progressKey, pageOrdinal: state.ordinal, label: null }),
      });
      const body = await response.json().catch(() => ({})) as { changed?: unknown };
      if (response.status === 200 && body.changed === true) bookmarkStatus = 'しおりを保存しました。';
      else if (response.status === 401) bookmarkError = 'ログインするとしおりを保存できます。';
      else bookmarkError = 'しおりを保存できませんでした。';
    } catch { bookmarkError = 'しおりを保存できませんでした。'; }
  }

  $: if (!$session.loading && $session.user && state && !remoteLoaded) void loadRemoteProgress();
  $: if (remoteLoaded && state && $session.user && lastRemoteOrdinal !== state.ordinal) {
    lastRemoteOrdinal = state.ordinal;
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => void putRemoteProgress(state!.ordinal), 250);
  }

  function transferNext(key: string) {
    if (!scheduler || nextTransferred || !state?.descriptor.nextPublicationId || !nextSession) return;
    if (key !== `next:${state.descriptor.nextPublicationId}`) return;
    const resource = scheduler.take(key);
    if (!resource) return;
    storeNextHandoff({ publicationId: state.descriptor.nextPublicationId, ...nextSession, resource });
    nextTransferred = true;
  }

  $: if (state) {
    savePresentation(state.presentation);
    if (state.persistProgress) saveProgress(state.descriptor, state.ordinal);
  }
  $: position = state ? pagePosition(state) : null;
  $: visible = state ? visibleOrdinals(state) : [];
  $: rendered = state
    ? visible.filter((page) => retainedResourceKeys(state!, direction).includes(`page:${page}`))
    : [];
  $: if (state && !refreshingDescriptor) {
    const ordinalIndex = state.descriptor.validOrdinals.indexOf(state.ordinal);
    const ahead = state.descriptor.validOrdinals[ordinalIndex + direction];
    const pageKey = (page: number) => `page:${page}`;
    const nextKey = `next:${state.descriptor.nextPublicationId ?? ''}`;
    const nearEnd = ordinalIndex >= state.descriptor.validOrdinals.length - 2;
    const retained = retainedResourceKeys(state, direction);
    if (!scheduler) {
      scheduler = new PageResourceScheduler(
        async (key, signal) => {
          if (key.startsWith('page:')) return `/api/reader/releases/${state?.releaseId}/pages/${key.slice(5)}`;
          const publicationId = key.slice(5);
          const response = await fetch(`/api/reader/publications/${publicationId}`, { cache: 'no-store', signal });
          const body: { session: { releaseId: string; release: ReaderDescriptor } | null } = await response.json();
          if (!response.ok || !body.session || !validReleaseId(body.session.releaseId) || body.session.release.validOrdinals.length === 0) throw new Error('next_unavailable');
          nextSession = { releaseId: body.session.releaseId, ordinal: body.session.release.validOrdinals[0] };
          return `/api/reader/releases/${body.session.releaseId}/pages/${body.session.release.validOrdinals[0]}`;
        },
        () => resourceVersion += 1,
        () => {
          if (!refreshedDescriptor) {
            refreshedDescriptor = true;
            refreshingDescriptor = true;
            scheduler?.clear();
            scheduler = null;
            void loadDescriptor(true);
          }
          else pageError = state?.ordinal ?? null;
        },
        transferNext,
      );
    }
    if (scheduler) {
      scheduler.retain(retained);
      if (incomingHandoff) {
        const key = pageKey(state.ordinal);
        if (!scheduler.adopt(key, incomingHandoff.resource)) URL.revokeObjectURL(incomingHandoff.resource.url);
        incomingHandoff = null;
      }
      for (const key of foregroundResourceKeys(state, direction)) scheduler.request(key, 'foreground');
      if (ahead !== undefined && !visible.includes(ahead) && retained.includes(pageKey(ahead)))
        scheduler.request(pageKey(ahead), 'prefetch');
      if (nearEnd && state.descriptor.nextPublicationId && retained.includes(nextKey) && !nextTransferred)
        scheduler.request(nextKey, 'prefetch');
    }
  }

  function navigate(step: -1 | 1) { if (state) { direction = step; state = { ...move(state, step), persistProgress: true }; pageError = null; } }
  async function focusResume() {
    await tick();
    if (showResume) resumePrimary?.focus();
  }
  function restoreResumeFocus() {
    const target = resumeFocusOrigin && document.contains(resumeFocusOrigin) ? resumeFocusOrigin : document.querySelector<HTMLButtonElement>('.reader-surface');
    target?.focus(); resumeFocusOrigin = null;
  }
  function resume() {
    if (state && pendingResume !== null) state = { ...state, ordinal: pendingResume, persistProgress: true };
    setResumeVisible(false);
    pendingResume = null;
    restoreResumeFocus();
  }
  function startOver() { if (state) state = { ...state, ordinal: state.descriptor.validOrdinals[0]!, persistProgress: true }; setResumeVisible(false); pendingResume = null; restoreResumeFocus(); }
  function updatePresentation(update: Partial<typeof defaultPresentation>) { if (state) state = setPresentation(state, update); }
  function changeMode(event: Event) {
    const mode = (event.currentTarget as HTMLSelectElement).value;
    if (mode === 'paged' || mode === 'spread' || mode === 'vertical' || mode === 'webtoon')
      updatePresentation({ mode });
  }
  function changeDirection(event: Event) {
    const direction = (event.currentTarget as HTMLSelectElement).value;
    if (direction === 'rtl' || direction === 'ltr') updatePresentation({ direction });
  }
  function tap(event: MouseEvent) {
    if (!state || event.detail === 0 || !pointerTapReady || suppressPointerTap) {
      pointerTapReady = false;
      suppressPointerTap = false;
      return;
    }
    pointerTapReady = false;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = (event.clientX - bounds.left) / bounds.width;
    if (tapTimer) clearTimeout(tapTimer);
    pointerDoubleTapCandidate = true;
    tapTimer = setTimeout(() => {
      pointerDoubleTapCandidate = false;
      tapTimer = null;
      if (zone < .3) navigate(state!.presentation.direction === 'rtl' ? 1 : -1);
      else if (zone > .7) navigate(state!.presentation.direction === 'rtl' ? -1 : 1);
    }, 250);
  }
  function keydown(event: KeyboardEvent) {
    if (!state || event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(state.presentation.direction === 'rtl' ? 1 : -1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); navigate(state.presentation.direction === 'rtl' ? -1 : 1); }
    if (event.key === 'Home') { event.preventDefault(); state = { ...state, ordinal: state.descriptor.validOrdinals[0]!, persistProgress: true }; }
    if (event.key === 'End') { event.preventDefault(); state = { ...state, ordinal: state.descriptor.validOrdinals.at(-1)!, persistProgress: true }; }
  }
  function pointerup(event: PointerEvent) {
    if (!event.isPrimary) return;
    if (!state || startX === null) return;
    const step = gestureStep(startX, event.clientX, reader.clientWidth, state.presentation.direction);
    startX = null;
    if (step) { suppressPointerTap = true; navigate(step); }
  }
  function pointerdown(event: PointerEvent) {
    if (!event.isPrimary) return;
    startX = event.clientX;
    pointerTapReady = true;
    suppressPointerTap = false;
  }
  function pointercancel() { startX = null; pointerTapReady = false; suppressPointerTap = false; }
  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await reader?.requestFullscreen?.(); else await document.exitFullscreen?.();
      fullscreenError = '';
    } catch {
      fullscreenError = '全画面表示を切り替えられませんでした。';
    }
  }
  function doubleTap() {
    if (!state || !pointerDoubleTapCandidate) return;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = null;
    pointerDoubleTapCandidate = false;
    updatePresentation({ zoom: state.presentation.zoom === 1 ? 2 : 1 });
  }
  function pageVisible(node: HTMLElement, options: { page: number; continuous: boolean }) {
    let observer: IntersectionObserver | undefined;
    let page = options.page;
    const observe = (next: typeof options) => {
      observer?.disconnect();
      visibility.delete(page);
      page = next.page;
      if (!next.continuous || typeof IntersectionObserver === 'undefined') return;
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) visibility.set(page, entry.isIntersecting ? entry.intersectionRatio : 0);
        const active = [...visibility.entries()]
          .filter(([, ratio]) => ratio > 0)
          .sort(([leftPage, leftRatio], [rightPage, rightRatio]) => rightRatio - leftRatio || leftPage - rightPage)[0];
        if (state && active && active[0] !== state.ordinal)
          state = { ...state, ordinal: active[0], persistProgress: true };
      }, { threshold: [0, .6, 1] });
      observer.observe(node);
    };
    observe(options);
    return { update: observe, destroy: () => { observer?.disconnect(); visibility.delete(page); } };
  }
  onMount(() => {
    const updateFullscreen = () => fullscreen = Boolean(document.fullscreenElement);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  });
</script>

<svelte:head><title>gutter — Reader</title></svelte:head>

<section bind:this={reader} class:width-fit={state?.presentation.fit === 'width'} class="reader" aria-label="リーダー">
  <button class="reader-surface" type="button" aria-label="リーダーのページ操作" onkeydown={keydown} onpointerdown={pointerdown} onpointerup={pointerup} onpointercancel={pointercancel} onclick={tap} ondblclick={doubleTap}></button>
  {#if error}
    <div class="slot"><p role="alert">{error}</p><button onclick={() => void loadDescriptor(true)}>再試行</button></div>
  {:else if !state}
    <p aria-live="polite">読み込み中…</p>
  {:else}
    <p class="reader-help" aria-label="リーダーの使い方">左右キー・スワイプでページ移動。ダブルタップで拡大。表示形式・読む方向・全画面は下の操作から変更できます。</p>
    {#if showResume}
      <div bind:this={resumeDialog} class="resume" role="dialog" aria-modal="true" aria-labelledby="resume-title"><h2 id="resume-title">読書を再開</h2><p>前回の続きがあります。</p><button bind:this={resumePrimary} onclick={resume}>続きから読む</button><button onclick={startOver}>最初から読む</button></div>
    {/if}
    <div class:spread={state.presentation.mode === 'spread'} class="pages" data-resource-version={resourceVersion} style:transform={`scale(${state.presentation.zoom})`} aria-live="polite">
      {#each rendered as page (page)}
        {#if pageError === page}
          <div class="page-error" role="alert">このページを表示できません。<button onclick={() => pageError = null}>再試行</button></div>
        {:else}
          {#if resourceVersion >= 0 && scheduler?.failure(`page:${page}`)}
            <div class="page-error" role="alert">{scheduler.failure(`page:${page}`) === 'offline' ? 'オフラインのためこのページを表示できません。' : 'このページを表示できません。'}<button onclick={() => scheduler?.retry(`page:${page}`, 'foreground')}>再試行</button></div>
          {:else if resourceVersion >= 0 && scheduler?.get(`page:${page}`)}
            <img use:pageVisible={{ page, continuous: state.presentation.mode === 'vertical' || state.presentation.mode === 'webtoon' }} loading="lazy" src={scheduler.get(`page:${page}`)?.url} alt={`ページ ${state.descriptor.validOrdinals.indexOf(page) + 1}`} onerror={() => pageError = page} />
          {:else}
            <div aria-live="polite">ページを読み込み中…</div>
          {/if}
        {/if}
      {/each}
    </div>
    <nav aria-label="リーダー操作">
      <button aria-label="前のページ" onclick={() => navigate(-1)} disabled={!canMove(state, -1)}>前へ</button>
      <span aria-live="polite">{position?.current} / {position?.total}</span>
      <button aria-label="次のページ" onclick={() => navigate(1)} disabled={!canMove(state, 1)}>次へ</button>
      <label>表示<select aria-label="表示形式" value={state.presentation.mode} onchange={changeMode}><option value="paged">ページ</option><option value="spread">見開き</option><option value="vertical">縦読み</option><option value="webtoon">ウェブトゥーン</option></select></label>
      <label>方向<select aria-label="読む方向" value={state.presentation.direction} onchange={changeDirection}><option value="rtl">右から左</option><option value="ltr">左から右</option></select></label>
      <button aria-label="表示を切り替え" onclick={() => updatePresentation({ fit: state!.presentation.fit === 'contain' ? 'width' : 'contain' })}>フィット</button>
      <button aria-label="拡大" onclick={() => updatePresentation({ zoom: Math.min(3, state!.presentation.zoom + .25) })}>拡大</button>
      <button aria-label="拡大をリセット" onclick={() => updatePresentation({ zoom: 1 })}>リセット</button>
      <button aria-label="全画面表示" aria-pressed={fullscreen} onclick={toggleFullscreen}>全画面</button>
      {#if $session.user}<button aria-label="しおりを保存" onclick={() => void addBookmark()}>しおり</button>{:else if !$session.loading}<a href={loginHref(currentDestination())}>ログインして同期</a>{/if}
      {#if bookmarkStatus}<span role="status" aria-live="polite">{bookmarkStatus}</span>{/if}
      {#if bookmarkError}<span role="alert">{bookmarkError}</span>{/if}
      {#if remoteStatus}<span role="status" aria-live="polite">{remoteStatus}</span>{/if}
      {#if remoteError}<span role="status" aria-live="polite">{remoteError}</span>{/if}
      {#if fullscreenError}<span role="alert">{fullscreenError}<button onclick={toggleFullscreen}>再試行</button></span>{/if}
    </nav>
    {#if !canMove(state, 1)}
      <aside class="end" aria-label="読了">読了{#if state.descriptor.nextPublicationId}<a href={`/reader/publications/${state.descriptor.nextPublicationId}`}>次の作品を読む</a>{/if}</aside>
    {/if}
  {/if}
</section>

<style>
  :global(main) { padding: 0; }
  :global(main > header) { display: none; }
  .reader { position: relative; min-height: 100vh; display: grid; place-items: center; background: #000; overflow: auto; }
  .reader-help { position: fixed; z-index: 2; top: 1rem; left: 1rem; max-width: min(32rem, calc(100vw - 2rem)); margin: 0; padding: .5rem .75rem; color: #d7dbe5; background: rgb(0 0 0 / .72); border-radius: .4rem; font-size: .875rem; }
  .reader-surface { position: fixed; inset: 0; z-index: 1; width: 100vw; height: 100vh; border: 0; background: transparent; cursor: pointer; }
  .reader-surface:focus-visible { outline: 3px solid #7dd3fc; outline-offset: -3px; }
  .pages { position: relative; z-index: 0; display: flex; max-width: 100vw; max-height: 100vh; pointer-events: none; transition: transform .15s ease; transform-origin: center; }
  .pages.spread { gap: .25rem; } img { display: block; min-width: 0; max-width: 100vw; max-height: 100vh; object-fit: contain; }
  .pages:has(img:nth-child(n + 2)):not(.spread) { align-items: center; flex-direction: column; }
  .width-fit img { width: 100vw; max-height: none; } .slot, .page-error, .resume { position: relative; z-index: 2; padding: 1rem; text-align: center; }
  nav { position: fixed; z-index: 2; inset: auto 1rem 1rem auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: end; gap: .5rem; max-width: calc(100vw - 2rem); }
  button { min-height: 2.75rem; border: 1px solid #555; border-radius: .5rem; padding: .5rem .75rem; font: inherit; }
  select { margin-inline-start: .25rem; min-height: 2.25rem; } .end { position: fixed; z-index: 2; top: 1rem; right: 1rem; display: grid; gap: .5rem; } .end a { color: #fff; }
  @media (prefers-reduced-motion: reduce) { .pages { transition: none; } }
</style>
