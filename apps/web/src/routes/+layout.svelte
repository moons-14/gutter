<script lang="ts">
  import { onMount } from 'svelte';
  import {
    currentDestination,
    loginHref,
    refreshSession,
    session,
    signOut,
  } from '$lib/session';
  let signOutError = '';
  let signOutStatus = '';
  let loginTarget = '/login';

  onMount(() => {
    loginTarget = loginHref(currentDestination());
    void refreshSession();
  });

  async function handleSignOut() {
    signOutError = '';
    signOutStatus = '';
    try {
      await signOut();
      loginTarget = '/login';
      signOutStatus = 'ログアウトしました。';
    } catch {
      signOutError = 'ログアウトに失敗しました。';
    }
  }
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
      {#if $session.user?.role === 'admin'}<a href="/settings/admin">管理者設定</a>{/if}
    </nav>
    <div class="session-actions">
      {#if $session.loading}
        <span class="session-status" aria-live="polite">セッションを確認中…</span>
      {:else if $session.user}
        <span class="account-name">{$session.user.name || $session.user.email || 'アカウント'}</span>
        <button class="account-action" type="button" onclick={() => void handleSignOut()}>ログアウト</button>
      {:else}
        <a class="account-action" href={loginTarget}>ログイン</a>
      {/if}
    </div>
  </header>
  {#if signOutStatus}<p class="session-feedback" role="status">{signOutStatus}</p>{/if}
  {#if signOutError}<p class="session-feedback" role="alert">{signOutError}</p>{/if}
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
  .session-actions { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:.5rem; }
  .account-name, .session-status { color:#c8ccd5; font-size:.875rem; }
  .account-action { border:1px solid #555; border-radius:.5rem; padding:.5rem .65rem; background:#d9e8ff; color:#101114; font:inherit; font-weight:700; text-decoration:none; cursor:pointer; white-space:nowrap; }
  .session-feedback { margin:.75rem 0; }
  :global(a:focus-visible), :global(button:focus-visible), :global(input:focus-visible), :global(select:focus-visible) { outline:3px solid #8cb7ed; outline-offset:3px; }
  @media (max-width: 680px) { header { align-items:flex-start; flex-wrap:wrap; } nav { order:3; flex-basis:100%; } .session-actions { margin-left:auto; } }
</style>
