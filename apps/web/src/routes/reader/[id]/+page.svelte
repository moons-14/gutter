<script lang="ts">
  import { onMount } from 'svelte';

  export let data: { id: string };
  type Descriptor = {
    progressKey: string;
    revision: string;
    validOrdinals: number[];
    validPageCount: number;
    nextPublicationId: string | null;
  };
  let descriptor: Descriptor | null = null;
  let ordinal: number | null = null;
  let error = '';

  onMount(async () => {
    try {
      const response = await fetch(`/api/reader/releases/${data.id}`, { cache: 'no-store' });
      const body: { release: Descriptor | null } = await response.json();
      if (!response.ok || !body.release || body.release.validOrdinals.length === 0)
        throw new Error('reader_unavailable');
      descriptor = body.release;
      ordinal = descriptor.validOrdinals[0]!;
    } catch {
      error = 'このリリースは現在読めません。';
    }
  });

  function move(step: -1 | 1) {
    if (!descriptor || ordinal === null) return;
    const current = descriptor.validOrdinals.indexOf(ordinal);
    ordinal = descriptor.validOrdinals[current + step] ?? ordinal;
  }
</script>

<svelte:head><title>gutter — Reader</title></svelte:head>

<section class="reader" aria-label="リーダー">
  {#if error}
    <p role="alert">{error}</p>
  {:else if ordinal === null}
    <p aria-live="polite">読み込み中…</p>
  {:else}
    <img src={`/api/reader/releases/${data.id}/pages/${ordinal}`} alt="" />
    <nav aria-label="ページ移動">
      <button onclick={() => move(-1)} disabled={descriptor?.validOrdinals[0] === ordinal}>前へ</button>
      <button onclick={() => move(1)} disabled={descriptor?.validOrdinals.at(-1) === ordinal}>次へ</button>
    </nav>
  {/if}
</section>

<style>
  :global(main) { padding: 0; }
  :global(main > header) { display: none; }
  .reader { min-height: 100vh; display: grid; place-items: center; background: #000; }
  img { display: block; max-width: 100vw; max-height: 100vh; object-fit: contain; }
  nav { position: fixed; inset: auto 1rem 1rem auto; display: flex; gap: .5rem; }
  button { min-height: 2.75rem; border: 1px solid #555; border-radius: .5rem; padding: .5rem .75rem; font: inherit; }
</style>
