<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchCatalog, type CatalogRequestState } from '$lib/catalog-fetch';
  type Series = { id: string; displayName: string; libraryId: string; publicationCount: number };
  let items: Series[] = []; let nextCursor: string | null = null; let loading = true; let state: CatalogRequestState = 'success'; let query = ''; let libraryId = ''; let kind = ''; let creator = ''; let group = ''; let publisher = ''; let sort = 'name'; let direction = 'asc';
  function queryParams(cursor?: string | null) {
    const params = new URLSearchParams({ limit: '30', sort, direction });
    if (query) params.set('q', query); if (libraryId) params.set('libraryId', libraryId); if (kind) params.set('kind', kind); if (creator) params.set('creator', creator); if (group) params.set('group', group); if (publisher) params.set('publisher', publisher);
    if (cursor) params.set('cursor', cursor); return params;
  }
  async function load(append = false, cursor?: string | null) {
    loading = true; state = 'success';
    const result = await fetchCatalog<{ items: Series[]; nextCursor: string | null }>(`/api/catalog/series?${queryParams(cursor)}`);
    if (result.state === 'success') { items = append ? [...items, ...result.data.items] : result.data.items; nextCursor = result.data.nextCursor; }
    else state = result.state;
    loading = false;
  }
  onMount(load);
</script>

<svelte:head><title>gutter — Catalog</title></svelte:head>
<section aria-labelledby="catalog-title">
  <h1 id="catalog-title">作品一覧</h1>
  <p class="lede">ライブラリから読みたい作品を探し、続きから読めます。</p>
  <nav aria-label="カタログを探す"><a href="/creators">作家</a><a href="/groups">グループ</a><a href="/publishers">出版社</a></nav>
  <form onsubmit={(event) => { event.preventDefault(); void load(); }}>
    <label>検索 <input bind:value={query} placeholder="タイトル・シリーズ" /></label>
    <label>ライブラリ <input bind:value={libraryId} placeholder="すべて" /></label>
    <label>種別 <select bind:value={kind}><option value="">すべて</option><option value="volume">巻</option><option value="chapter">話</option><option value="issue">号</option><option value="special">特別編</option><option value="artbook">画集</option></select></label>
    <label>作家 <input bind:value={creator} placeholder="作家名" /></label>
    <label>グループ <input bind:value={group} placeholder="グループ名" /></label>
    <label>出版社 <input bind:value={publisher} placeholder="出版社名" /></label>
    <label>並び替え <select bind:value={sort}><option value="name">名前</option><option value="source_updated">更新</option><option value="discovered">登録</option><option value="metadata_updated">メタデータ</option></select></label>
    <label>順序 <select bind:value={direction}><option value="asc">昇順</option><option value="desc">降順</option></select></label>
    <button>検索</button>
  </form>
  {#if loading}<p aria-live="polite">読み込み中…</p>
  {:else if state === 'not-found'}<p role="alert">カタログが見つかりません。</p><button onclick={() => void load()}>再試行</button>
  {:else if state === 'unavailable'}<p role="alert">カタログは現在利用できません。</p><button onclick={() => void load()}>再試行</button>
  {:else if state === 'network'}<p role="alert">ネットワークに接続できませんでした。</p><button onclick={() => void load()}>再試行</button>
  {:else if state === 'error'}<p role="alert">カタログの読み込みに失敗しました。</p><button onclick={() => void load()}>再試行</button>
  {:else if items.length === 0}<section class="empty"><h2>作品はまだありません</h2><p>スキャンが完了すると、ここに作品が表示されます。</p></section>
  {:else}<p class="count">{items.length} 件を表示</p><ul class="grid">{#each items as item}<li><a href={`/series/${item.id}`}><strong>{item.displayName}</strong><span>{item.libraryId} · {item.publicationCount} 件</span><b>詳細を見る →</b></a></li>{/each}</ul>{#if nextCursor}<button onclick={() => void load(true, nextCursor)}>さらに読み込む</button>{/if}{/if}
</section>

<style>
  .lede, .count { color:#babdc5; } form { display:grid; grid-template-columns:repeat(auto-fit,minmax(10rem,1fr)); gap:.75rem; margin:1rem 0 1.5rem; padding:1rem; background:#1b1d22; border-radius:.75rem; } label { display:grid; gap:.25rem; } input,select,button { min-height:2.75rem; border-radius:.5rem; border:1px solid #555; padding:.5rem; font:inherit; } button { background:#c7e4ff; color:#081018; font-weight:700; cursor:pointer; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(14rem,1fr)); gap:.75rem; padding:0; list-style:none; } a { display:grid; min-height:8rem; padding:1rem; border:1px solid #30333b; border-radius:.75rem; background:#1b1d22; color:inherit; text-decoration:none; gap:.5rem; } a:hover { border-color:#8cb7ed; background:#22252c; } span { color:#babdc5; font-size:.9rem; } b { margin-top:auto; color:#b9d8ff; font-size:.875rem; } .empty { padding:1.5rem; border:1px dashed #4a4f5a; border-radius:.75rem; }
</style>
