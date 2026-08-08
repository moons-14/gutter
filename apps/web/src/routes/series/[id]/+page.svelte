<script lang="ts">
  import { onMount } from 'svelte'; export let data: { id: string }; let detail: any; let error = '';
  onMount(async () => { try { const r = await fetch(`/api/catalog/series/${data.id}`); if (!r.ok) throw Error(); detail = await r.json(); } catch { error = '作品を読み込めませんでした。'; } });
</script>
{#if error}<p role="alert">{error}</p>{:else if !detail}<p>読み込み中…</p>{:else}<nav><a href="/">← 作品一覧</a></nav><h1>{detail.displayName}</h1><ul>{#each detail.publications as publication}<li><a href={`/publications/${publication.id}`}>{publication.displayName} <small>{publication.kind}</small></a></li>{/each}</ul>{/if}
