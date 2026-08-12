<script lang="ts">
  import { onMount } from 'svelte';
  import { authClient } from '$lib/auth-client';
  import {
    intendedDestination,
    redirectAfterAuth,
    refreshSession,
  } from '$lib/session';

  let email = '';
  let password = '';
  let verificationCode = '';
  let recoveryCode = false;
  let needsTwoFactor = false;
  let nextDestination = '/';
  let message = '';
  let error = '';
  let busy = false;
  let passkeySupported = true;

  onMount(() => {
    nextDestination = intendedDestination();
    passkeySupported = typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials?.get;
  });

  function authError(status: number): string {
    if (status === 429) return '試行回数が多すぎます。しばらくしてからもう一度お試しください。';
    return 'メールアドレスまたはパスワードを確認してください。';
  }

  async function signIn() {
    busy = true;
    error = '';
    message = '';
    try {
      const response = await authClient.signIn.email({ email, password });
      if (response.error) throw new Error(authError(response.error.status));
      const signInData = response.data as { twoFactorRedirect?: boolean } | null;
      if (signInData?.twoFactorRedirect) {
        needsTwoFactor = true;
        message = '二要素認証コードを入力してください。';
      } else {
        await refreshSession();
        redirectAfterAuth(nextDestination);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'ログインに失敗しました。';
    } finally {
      busy = false;
    }
  }

  async function verifyTwoFactor() {
    busy = true;
    error = '';
    message = '';
    try {
      const response = recoveryCode
        ? await authClient.twoFactor.verifyBackupCode({ code: verificationCode, trustDevice: false })
        : await authClient.twoFactor.verifyTotp({ code: verificationCode, trustDevice: false });
      if (response.error) throw new Error('認証コードを確認できませんでした。');
      needsTwoFactor = false;
      verificationCode = '';
      await refreshSession();
      redirectAfterAuth(nextDestination);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '認証コードを確認できませんでした。';
    } finally {
      busy = false;
    }
  }

  async function signInWithPasskey() {
    busy = true;
    error = '';
    message = '';
    try {
      const response = await authClient.signIn.passkey();
      if (response.error) throw new Error('パスキー認証を確認できませんでした。');
      await refreshSession();
      redirectAfterAuth(nextDestination);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'パスキー認証に失敗しました。';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>gutter — ログイン</title></svelte:head>
<section class="card" aria-labelledby="login-title">
  <h1 id="login-title">ログイン</h1>
  <p>この端末のGutterアカウントで続けます。</p>
  {#if needsTwoFactor}
    <form onsubmit={(event) => { event.preventDefault(); void verifyTwoFactor(); }}>
      <label>{recoveryCode ? '回復コード' : '認証アプリのコード'}<input bind:value={verificationCode} autocomplete="one-time-code" required /></label>
      <label class="choice"><input type="checkbox" bind:checked={recoveryCode} /> 回復コードを使う</label>
      <button disabled={busy}>{busy ? '確認中…' : '確認してログイン'}</button>
    </form>
  {:else}
    <form onsubmit={(event) => { event.preventDefault(); void signIn(); }}>
      <label>メールアドレス<input type="email" bind:value={email} autocomplete="email" required /></label>
      <label>パスワード<input type="password" bind:value={password} autocomplete="current-password" minlength="12" required /></label>
      <button disabled={busy}>{busy ? 'ログイン中…' : 'ログイン'}</button>
    </form>
    {#if passkeySupported}<button class="passkey" type="button" disabled={busy} onclick={() => void signInWithPasskey()}>パスキーでログイン</button>{/if}
  {/if}
  {#if message}<p role="status" aria-live="polite">{message}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <p class="minor">最初の管理者を作成する場合は <a href="/setup">初回設定</a> を使います。</p>
</section>

<style>
  .card { max-width:30rem; padding:1.5rem; background:#1b1d22; border:1px solid #30333b; border-radius:.8rem; }
  form { display:grid; gap:1rem; margin:1.5rem 0 1rem; }
  label { display:grid; gap:.4rem; }
  .choice { display:flex; align-items:center; gap:.5rem; }
  input,button { min-height:2.75rem; border:1px solid #555; border-radius:.5rem; padding:.55rem; font:inherit; }
  .choice input { min-height:1rem; }
  button { background:#d9e8ff; color:#101114; font-weight:700; cursor:pointer; }
  .passkey { width:100%; background:transparent; color:inherit; }
  .minor { color:#babdc5; font-size:.9rem; }
</style>
