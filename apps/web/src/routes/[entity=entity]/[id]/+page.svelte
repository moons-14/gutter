<script lang="ts">
  import { onMount } from 'svelte';
  export let data: { entity: string; id: string }; let detail: any; let error = '';
  onMount(async () => { try { const response = await fetch(`/api/catalog/${data.entity}/${data.id}`); if (!response.ok) throw Error(); detail = await response.json(); } catch { error = '情報を読み込めませんでした。'; } });
</script>
{#if error}<p role="alert">{error}</p>{:else if !detail}<p aria-live="polite">読み込み中…</p>{:else}<nav><a href="/">← 作品一覧</a></nav><h1>{detail.displayName}</h1><ul>{#each detail.publications as publication}<li><a href={`/publications/${publication.id}`}>{publication.displayName}</a><small> · {publication.seriesName}</small></li>{/each}</ul>{/if}
