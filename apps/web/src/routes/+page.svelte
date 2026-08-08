<script lang="ts">
  import { onMount } from 'svelte';
  type Series = { id: string; displayName: string; libraryId: string; publicationCount: number };
  let items: Series[] = []; let nextCursor: string | null = null; let loading = true; let error = ''; let query = ''; let libraryId = ''; let kind = ''; let sort = 'name'; let direction = 'asc';
  function queryParams(cursor?: string | null) {
    const params = new URLSearchParams({ limit: '30', sort, direction });
    if (query) params.set('q', query); if (libraryId) params.set('libraryId', libraryId); if (kind) params.set('kind', kind);
    if (cursor) params.set('cursor', cursor); return params;
  }
  async function load(append = false, cursor?: string | null) {
    loading = true; error = '';
    try {
      const response = await fetch(`/api/catalog/series?${queryParams(cursor)}`);
      if (!response.ok) throw new Error('catalog_unavailable');
      const page = await response.json(); items = append ? [...items, ...page.items] : page.items; nextCursor = page.nextCursor;
    } catch { error = 'カタログを読み込めませんでした。ローカル/LAN の信頼できるネットワークで確認してください。'; }
    finally { loading = false; }
  }
  onMount(load);
</script>

<svelte:head><title>gutter — Catalog</title></svelte:head>
<section aria-labelledby="catalog-title">
  <h1 id="catalog-title">作品一覧</h1>
  <nav aria-label="カタログを探す"><a href="/creators">作家</a><a href="/groups">グループ</a><a href="/publishers">出版社</a></nav>
  <form onsubmit={(event) => { event.preventDefault(); void load(); }}>
    <label>検索 <input bind:value={query} placeholder="タイトル・シリーズ" /></label>
    <label>ライブラリ <input bind:value={libraryId} placeholder="すべて" /></label>
    <label>種別 <select bind:value={kind}><option value="">すべて</option><option value="volume">巻</option><option value="chapter">話</option><option value="issue">号</option><option value="special">特別編</option><option value="artbook">画集</option></select></label>
    <label>並び替え <select bind:value={sort}><option value="name">名前</option><option value="source_updated">更新</option><option value="discovered">登録</option><option value="metadata_updated">メタデータ</option></select></label>
    <label>順序 <select bind:value={direction}><option value="asc">昇順</option><option value="desc">降順</option></select></label>
    <button>検索</button>
  </form>
  {#if loading}<p aria-live="polite">読み込み中…</p>
  {:else if error}<p role="alert">{error}</p>
  {:else if items.length === 0}<p>作品はまだありません。</p>
  {:else}<ul class="grid">{#each items as item}<li><a href={`/series/${item.id}`}><strong>{item.displayName}</strong><span>{item.libraryId} · {item.publicationCount} 件</span></a></li>{/each}</ul>{#if nextCursor}<button onclick={() => void load(true, nextCursor)}>さらに読み込む</button>{/if}{/if}
</section>

<style>
  nav { display:flex; flex-wrap:wrap; gap:.5rem; } nav a { min-height:auto; padding:.5rem .75rem; } form { display:grid; grid-template-columns:repeat(auto-fit,minmax(10rem,1fr)); gap:.75rem; margin:1rem 0 1.5rem; } label { display:grid; gap:.25rem; } input,select,button { min-height:2.75rem; border-radius:.5rem; border:1px solid #555; padding:.5rem; font:inherit; } button { background:#c7e4ff; color:#081018; font-weight:700; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(12rem,1fr)); gap:.75rem; padding:0; list-style:none; } a { display:grid; min-height:5rem; padding:1rem; border-radius:.75rem; background:#1b1d22; color:inherit; text-decoration:none; gap:.5rem; } span { color:#babdc5; font-size:.9rem; }
</style>
