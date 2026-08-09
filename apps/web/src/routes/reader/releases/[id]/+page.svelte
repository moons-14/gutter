<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
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
  let startX: number | null = null;
  let pendingResume: number | null = null;
  let pointerTapReady = false;
  let suppressPointerTap = false;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerDoubleTapCandidate = false;
  let reader: HTMLElement;
  let fullscreen = false;
  let fullscreenError = '';
  const visibility = new Map<number, number>();

  async function loadDescriptor(refresh = false) {
    try {
      error = '';
      nextSession = null;
      nextTransferred = false;
      const response = await fetch(
        publication ? `/api/reader/publications/${data.id}` : `/api/reader/releases/${data.id}`,
        { cache: 'no-store' },
      );
      const body: { release: ReaderDescriptor | null; session: { releaseId: string; release: ReaderDescriptor } | null } = await response.json();
      const releaseId = publication ? body.session?.releaseId : data.id;
      const descriptor = publication ? body.session?.release : body.release;
      if (!response.ok || !releaseId || !descriptor || descriptor.validOrdinals.length === 0)
        throw new Error('reader_unavailable');
      const saved = refresh ? null : loadProgress(descriptor);
      state = {
        releaseId,
        descriptor,
        ordinal: descriptor.validOrdinals[0]!,
        presentation: loadPresentation(),
        persistProgress: saved === null,
      };
      incomingHandoff = publication ? takeNextHandoff(data.id) : null;
      if (incomingHandoff && (incomingHandoff.releaseId !== releaseId || incomingHandoff.ordinal !== descriptor.validOrdinals[0])) {
        URL.revokeObjectURL(incomingHandoff.resource.url);
        incomingHandoff = null;
      }
      pendingResume = saved;
      showResume = saved !== null && saved !== state.ordinal;
    } catch {
      error = 'このリリースは現在読めません。';
    } finally {
      refreshingDescriptor = false;
    }
  }

  onMount(() => { void loadDescriptor(); });
  onDestroy(() => {
    scheduler?.clear();
    if (tapTimer) clearTimeout(tapTimer);
  });

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
          if (!response.ok || !body.session || body.session.release.validOrdinals.length === 0) throw new Error('next_unavailable');
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
  function resume() {
    if (state && pendingResume !== null) state = { ...state, ordinal: pendingResume, persistProgress: true };
    showResume = false;
    pendingResume = null;
  }
  function startOver() { if (state) state = { ...state, ordinal: state.descriptor.validOrdinals[0]!, persistProgress: true }; showResume = false; pendingResume = null; }
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
    <div class="slot"><p role="alert">{error}</p><button onclick={() => globalThis.location.reload()}>再試行</button></div>
  {:else if !state}
    <p aria-live="polite">読み込み中…</p>
  {:else}
    {#if showResume}
      <div class="resume" role="dialog" aria-label="読書を再開"><p>前回の続きがあります。</p><button onclick={resume}>続きから読む</button><button onclick={startOver}>最初から読む</button></div>
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
