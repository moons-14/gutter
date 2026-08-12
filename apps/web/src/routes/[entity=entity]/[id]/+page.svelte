<script lang="ts">
  import { onMount } from 'svelte'; import { fetchCatalog, type CatalogRequestState } from '$lib/catalog-fetch';
  export let data: { entity: string; id: string }; let detail: any; let loading = true; let state: CatalogRequestState = 'success';
  async function load() { loading = true; state = 'success'; const result = await fetchCatalog<any>(`/api/catalog/${data.entity}/${data.id}`); if (result.state === 'success') detail = result.data; else state = result.state; loading = false; }
  onMount(load);
</script>
{#if loading}<p aria-live="polite">読み込み中…</p>{:else if state === 'not-found'}<p role="alert">情報が見つかりません。</p><button onclick={() => void load()}>再試行</button>{:else if state === 'unavailable'}<p role="alert">情報は現在利用できません。</p><button onclick={() => void load()}>再試行</button>{:else if state === 'network'}<p role="alert">ネットワークに接続できませんでした。</p><button onclick={() => void load()}>再試行</button>{:else if state === 'error'}<p role="alert">情報の読み込みに失敗しました。</p><button onclick={() => void load()}>再試行</button>{:else}<nav><a href="/">← 作品一覧</a></nav><h1>{detail.displayName}</h1>{#if detail.publications?.length}<ul>{#each detail.publications as publication}<li><a href={`/publications/${publication.id}`}>{publication.displayName}</a><small> · {publication.seriesName}</small></li>{/each}</ul>{:else}<p aria-live="polite">関連する作品はまだありません。</p>{/if}{/if}
