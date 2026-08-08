<script lang="ts">
  import { onMount } from 'svelte'; export let data: { id: string }; let detail: any; let error = '';
  onMount(async () => { try { const r = await fetch(`/api/catalog/publications/${data.id}`); if (!r.ok) throw Error(); detail = await r.json(); } catch { error = '巻を読み込めませんでした。'; } });
</script>
{#if error}<p role="alert">{error}</p>{:else if !detail}<p>読み込み中…</p>{:else}<nav><a href={`/series/${detail.seriesId}`}>← {detail.seriesName}</a></nav><h1>{detail.displayName}</h1>{#if detail.credits?.length}<h2>クレジット</h2><ul>{#each detail.credits as credit}<li><a href={`/${credit.kind === 'creator' ? 'creators' : credit.kind === 'group' ? 'groups' : 'publishers'}/${credit.id}`}>{credit.displayName}</a> · {credit.role}</li>{/each}</ul>{/if}<h2>利用可能なリリース</h2><ul>{#each detail.releases as release}<li>{release.relativePath} · {release.pageCount} ページ</li>{/each}</ul>{/if}
