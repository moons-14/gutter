<script lang="ts">
  import { onMount } from 'svelte';
  import { session, loginHref, currentDestination } from '$lib/session';
  type User = { id: string; name: string; email: string; role: string | null; banned: boolean };
  type Library = { id: string; displayName: string };
  type DirectoryPage = { items: User[]; nextCursor: string | null };
  let users: User[] = [], libraries: Library[] = [], selected: User | null = null;
  let q = '', libraryId = '', cursor: string | null = null, loading = false, message = '', error = '';
  let mounted = false, generation = 0, activeRequest: AbortController | null = null, libraryRequest: AbortController | null = null, loadingPage = false, started = false, sessionIdentity = '';

  function resetForSessionChange(identity: string) {
    if (identity === sessionIdentity) return;
    sessionIdentity = identity; generation++; activeRequest?.abort(); libraryRequest?.abort();
    users = []; libraries = []; selected = null; cursor = null; q = ''; libraryId = '';
    loading = false; loadingPage = false; message = ''; error = ''; started = false;
  }

  async function load(reset = true) {
    if (!mounted || !$session.user || $session.user.role !== 'admin' || (loadingPage && !reset)) return;
    const snapshotQ = q.trim(), snapshotCursor = reset ? null : cursor, requestGeneration = ++generation;
    if (!reset && !snapshotCursor) return;
    loadingPage = true; loading = true; error = '';
    activeRequest?.abort(); const controller = new AbortController(); activeRequest = controller;
    const params = new URLSearchParams({ limit: '30' });
    if (snapshotQ) params.set('q', snapshotQ); if (snapshotCursor) params.set('cursor', snapshotCursor);
    try {
      const response = await fetch(`/api/admin/users?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 404 ? 'not_found' : 'request_failed');
      const body = await response.json() as DirectoryPage;
      if (!mounted || requestGeneration !== generation) return;
      users = reset ? body.items : [...users, ...body.items]; cursor = body.nextCursor;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (!mounted || requestGeneration !== generation) return;
      error = e instanceof Error && e.message === 'not_found' ? '管理者のみ利用できます。' : 'ユーザー一覧を読み込めませんでした。';
    } finally { if (requestGeneration === generation) { loading = false; loadingPage = false; } }
  }
  async function loadLibraries() {
    if (!mounted || !$session.user || $session.user.role !== 'admin') return;
    const controller = new AbortController(); libraryRequest?.abort(); libraryRequest = controller;
    try { const response = await fetch('/api/catalog/libraries', { signal: controller.signal }); if (response.ok && mounted) libraries = (await response.json()).items; }
    catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError') && mounted) error = 'ライブラリを読み込めませんでした。'; }
  }
  async function changeAccess(action: 'grant' | 'revoke') {
    if (!selected || !libraryId || !$session.user || $session.user.role !== 'admin') return;
    message = ''; error = '';
    const response = await fetch(`/api/admin/library-access/${encodeURIComponent(selected.id)}/${encodeURIComponent(libraryId)}`, { method: action === 'grant' ? 'PUT' : 'DELETE' });
    if (!response.ok) { error = 'アクセス権を変更できませんでした。'; return; }
    message = action === 'grant' ? 'アクセスを付与しました。' : 'アクセスを取り消しました。';
  }
  $: {
    const identity = $session.loading ? 'loading' : $session.user ? `${$session.user.id ?? ''}:${$session.user.role ?? ''}` : 'anonymous';
    if (mounted) resetForSessionChange(identity);
    if (mounted && !$session.loading && $session.user?.role === 'admin' && !started) { started = true; void load(); void loadLibraries(); }
  }
  onMount(() => { mounted = true; return () => { mounted = false; generation++; activeRequest?.abort(); libraryRequest?.abort(); }; });
</script>

<svelte:head><title>gutter — 管理者設定</title></svelte:head>
{#if $session.loading}<p aria-live="polite">セッションを確認中…</p>
{:else if !$session.user}<section aria-labelledby="admin-title"><h1 id="admin-title">管理者設定</h1><p>管理者としてログインしてください。</p><a href={loginHref(currentDestination())}>ログイン</a></section>
{:else if $session.user.role !== 'admin'}<section aria-labelledby="admin-title"><h1 id="admin-title">管理者設定</h1><p role="alert">管理者のみ利用できます。</p></section>
{:else}<section aria-labelledby="admin-title"><h1 id="admin-title">管理者設定</h1>
  <form onsubmit={(event) => { event.preventDefault(); cursor = null; generation++; void load(); }}><label>ユーザー検索 <input bind:value={q} maxlength="256" placeholder="名前またはメールアドレス" /></label><button>検索</button></form>
  {#if loading}<p aria-live="polite">読み込み中…</p>{:else if error}<p role="alert">{error}</p>{:else if users.length === 0}<p>ユーザーが見つかりません。</p>{:else}<ul aria-label="ユーザー一覧">{#each users as user}<li><button class:selected={selected?.id === user.id} type="button" onclick={() => selected = user}><strong>{user.name}</strong><span>{user.email} · {user.role ?? 'user'}{user.banned ? ' · banned' : ''}</span></button></li>{/each}</ul>{#if cursor}<button type="button" disabled={loadingPage} onclick={() => void load(false)}>さらに読み込む</button>{/if}{/if}
  {#if selected}<section aria-labelledby="access-title"><h2 id="access-title">{selected.name} のライブラリアクセス</h2><label>ライブラリ <select bind:value={libraryId}><option value="">選択してください</option>{#each libraries as library}<option value={library.id}>{library.displayName}</option>{/each}</select></label><button disabled={!libraryId} onclick={() => void changeAccess('grant')}>付与</button><button disabled={!libraryId} onclick={() => void changeAccess('revoke')}>取り消し</button></section>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>{/if}
