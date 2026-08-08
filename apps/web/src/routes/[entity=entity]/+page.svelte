<script lang="ts">
  import { onMount } from 'svelte'; export let data: { entity: string }; let items: any[] = []; let error = '';
  const labels: Record<string, string> = { creators: '作家', groups: 'グループ', publishers: '出版社' };
  onMount(async () => { try { const response = await fetch(`/api/catalog/${data.entity}?limit=100`); if (!response.ok) throw Error(); items = (await response.json()).items; } catch { error = '一覧を読み込めませんでした。'; } });
</script>
<nav><a href="/">← 作品一覧</a></nav><h1>{labels[data.entity]}</h1>
{#if error}<p role="alert">{error}</p>{:else if !items.length}<p aria-live="polite">読み込み中、または項目はありません。</p>{:else}<ul>{#each items as item}<li><a href={`/${data.entity}/${item.id}`}>{item.displayName}</a> · {item.publicationCount} 件</li>{/each}</ul>{/if}
