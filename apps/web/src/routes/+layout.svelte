<script lang="ts">
</script>

<svelte:head><link rel="manifest" href="/manifest.webmanifest" /><meta name="theme-color" content="#101114" /></svelte:head>
<main>
  <header>
    <a class="brand" href="/" aria-label="gutter のホーム">gutter</a>
    <nav aria-label="メインナビゲーション">
      <a href="/">カタログ</a>
      <a href="/creators">作家</a>
      <a href="/groups">グループ</a>
      <a href="/publishers">出版社</a>
    </nav>
  </header>
  <slot />
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #101114; color: #f3f3f5; font-family: ui-sans-serif, system-ui, sans-serif; }
  :global(a) { color: inherit; }
  main { min-height: 100vh; max-width: 80rem; margin: auto; padding: clamp(1rem, 4vw, 3rem); }
  header { display:flex; align-items:center; gap:1rem; padding-bottom:1rem; border-bottom:1px solid #30333b; }
  .brand { color:#fff; font-size:1.3rem; font-weight:800; letter-spacing:-.04em; text-decoration:none; }
  nav { display:flex; flex:1; flex-wrap:wrap; gap:.25rem; } nav a { border-radius:.5rem; padding:.5rem .65rem; text-decoration:none; } nav a:hover, nav a:focus-visible { background:#282b33; }
  :global(a:focus-visible), :global(button:focus-visible), :global(input:focus-visible), :global(select:focus-visible) { outline:3px solid #8cb7ed; outline-offset:3px; }
  @media (max-width: 580px) { header { align-items:flex-start; flex-wrap:wrap; } nav { order:3; flex-basis:100%; } }
</style>
