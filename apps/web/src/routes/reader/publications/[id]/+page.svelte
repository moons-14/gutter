<script lang="ts">
  import Reader from '../../releases/[id]/+page.svelte';
  export let data: { id: string };
</script>

<Reader {data} publication />
