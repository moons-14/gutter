<script lang="ts">
  import { messages } from '$lib/i18n';
  const locale = typeof navigator === 'undefined' || navigator.language.startsWith('ja') ? 'ja' : 'en';
  const t = messages[locale];
</script>

<svelte:head><link rel="manifest" href="/manifest.webmanifest" /><meta name="theme-color" content="#101114" /></svelte:head>
<main><header><strong>gutter</strong><span>{t.foundation}</span></header><slot /></main>

<style>
  :global(body) { margin: 0; background: #101114; color: #f3f3f5; font-family: system-ui, sans-serif; }
  main { min-height: 100vh; padding: clamp(1rem, 4vw, 3rem); } header { display:flex; justify-content:space-between; gap:1rem; }
  @media (max-width: 480px) { header { align-items:flex-start; flex-direction:column; } }
</style>
