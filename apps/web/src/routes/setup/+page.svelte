<script lang="ts">
  import { onMount } from 'svelte';
  import {
    intendedDestination,
    loginHref,
    redirectAfterAuth,
    refreshSession,
  } from '$lib/session';

  let name = '';
  let email = '';
  let password = '';
  let confirmation = '';
  let nextDestination = '/';
  let message = '';
  let error = '';
  let busy = false;
  let unavailable = false;

  onMount(() => {
    nextDestination = intendedDestination();
  });

  async function bootstrap() {
    error = '';
    message = '';
    unavailable = false;
    if (password !== confirmation) {
      error = 'パスワードが一致しません。';
      return;
    }
    busy = true;
    try {
      const response = await fetch('/api/auth/bootstrap', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      if (!response.ok) {
        if (response.status === 403) {
          unavailable = true;
          throw new Error('初回設定はすでに完了しているか、この環境では利用できません。');
        }
        throw new Error('初回設定に失敗しました。');
      }
      await refreshSession();
      message = '管理者アカウントを作成しました。';
      redirectAfterAuth(nextDestination);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '初回設定に失敗しました。';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>gutter — 初回設定</title></svelte:head>
<section class="card" aria-labelledby="setup-title">
  <h1 id="setup-title">初回設定</h1>
  <p>新しいライブラリの最初の管理者を一度だけ作成します。</p>
  {#if unavailable}<p class="notice">この環境では初回設定を利用できません。既存のアカウントでログインしてください。</p>{/if}
  <form onsubmit={(event) => { event.preventDefault(); void bootstrap(); }}>
    <label>表示名<input bind:value={name} autocomplete="name" required /></label>
    <label>メールアドレス<input type="email" bind:value={email} autocomplete="email" required /></label>
    <label>パスワード<input type="password" bind:value={password} autocomplete="new-password" minlength="12" required /></label>
    <label>パスワード（確認）<input type="password" bind:value={confirmation} autocomplete="new-password" minlength="12" required /></label>
    <button disabled={busy}>{busy ? '作成中…' : '管理者を作成'}</button>
  </form>
  {#if message}<p role="status" aria-live="polite">{message} <a href={loginHref(nextDestination)}>ログインへ</a></p>{/if}
  {#if error}<p role="alert">{error}{#if unavailable} <a href={loginHref(nextDestination)}>ログインへ</a>{/if}</p>{/if}
</section>

<style>
  .card { max-width:34rem; padding:1.5rem; background:#1b1d22; border:1px solid #30333b; border-radius:.8rem; }
  form { display:grid; gap:1rem; margin:1.5rem 0; }
  label { display:grid; gap:.4rem; }
  input,button { min-height:2.75rem; border:1px solid #555; border-radius:.5rem; padding:.55rem; font:inherit; }
  button { background:#d9e8ff; color:#101114; font-weight:700; cursor:pointer; }
  .notice { padding:.75rem; border:1px solid #92702e; border-radius:.5rem; }
</style>
